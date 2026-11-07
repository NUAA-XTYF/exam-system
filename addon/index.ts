import { Context, Handler, ContestModel, PERM, ForbiddenError, ValidationError, param, Types } from 'hydrooj';
import { ObjectId } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Device } from './config';
import { Store, Exam } from './storage/store';
import { Scheduler } from './scheduler/scheduler';
import { VeyonClient } from './transport/veyon';
import { mayManage, validMappings } from './handlers/policy';
export const name = 'hydro-veyon-monitor';
const DEFAULT_RULES = [
  'chatgpt','claude','copilot','ollama','lmstudio','lm studio','llama','comfyui','stable diffusion',
  'wechat','weixin','\\bqq\\b','telegram','discord','whatsapp','skype','微信','企业微信','钉钉','飞书',
  'teamviewer','anydesk','sunlogin','todesk','rustdesk','parsec','\\bvnc\\b',
  'virtualbox','vmware','obs64','obs studio',
];
const allowInsecureHttp = process.env.EXAM_MONITOR_ALLOW_HTTP === '1';
export async function apply(ctx: Context) {
  const devices: Device[] = JSON.parse(await readFile(process.env.EXAM_MONITOR_DEVICES ?? 'devices.json','utf8'));
  const registry = new Map(devices.map(d => [d.id,d]));
  if (registry.size !== devices.length) throw new Error('Duplicate device ids');
  const keyFiles = new Set<string>();
  const keyHashes = new Set<string>();
  for (const d of devices) {
    const proto = new URL(d.origin).protocol;
    const protoOk = proto === 'https:' || (allowInsecureHttp && proto === 'http:');
    if (!/^[a-zA-Z0-9_-]+$/.test(d.id) || !protoOk || keyFiles.has(path.resolve(d.keyFile))) throw new Error('Invalid device or shared key file');
    keyFiles.add(path.resolve(d.keyFile));
    const hash=createHash('sha256').update(await readFile(d.keyFile)).digest('hex');
    if(keyHashes.has(hash)) throw new Error('Each device must have an independent key');keyHashes.add(hash);
  }
  const store = new Store(ctx.db.db, path.resolve(process.env.EXAM_MONITOR_DATA ?? 'data/exam-monitor')); await store.init();
  // ---- process reporting (student side agent) ----
  const tokenDevice = new Map<string, string>();
  try {
    const tokens = JSON.parse(await readFile(process.env.EXAM_MONITOR_TOKENS ?? '/etc/exam-monitor/tokens.json', 'utf8'));
    for (const [id, token] of Object.entries(tokens)) {
      if (registry.has(id) && typeof token === 'string' && token.length >= 16) tokenDevice.set(token, id);
    }
  } catch { console.error('Exam monitor: report tokens unavailable, process reporting disabled'); }
  const agents = ctx.db.db.collection('exam.monitor.agents');
  const rulesFile = process.env.EXAM_MONITOR_RULES ?? '/etc/exam-monitor/rules.txt';
  let rulesCache = { at: 0, list: [] as RegExp[] };
  const loadRules = async () => {
    if (Date.now() - rulesCache.at < 5000) return rulesCache.list;
    let lines: string[] = [];
    try {
      lines = (await readFile(rulesFile, 'utf8')).split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
    } catch { lines = DEFAULT_RULES; }
    const list: RegExp[] = [];
    for (const line of lines) { try { list.push(new RegExp(line, 'i')); } catch { /* ignore bad pattern */ } }
    rulesCache = { at: Date.now(), list };
    return list;
  };
  const client = new VeyonClient();
  const tasks = new Map<string, { exam: Exam; studentId: number; deviceId: string }>();
  const scheduler = new Scheduler(async (job, signal) => {
    const item = tasks.get(job.id); if (!item) return;
    const queueDelayMs = Math.max(0, performance.now() - job.planned);
    const plannedAt = Date.now() - queueDelayMs;
    const result = await client.capture(registry.get(item.deviceId)!, { directory: store.directory(item.exam._id,item.studentId), manual: job.manual }, signal);
    if (signal.aborted && result.path) { const { rm } = await import('node:fs/promises'); await rm(result.path,{force:true}); return; }
    await store.results.insertOne({ ...result, examId:item.exam._id, studentId:item.studentId, deviceId:item.deviceId, plannedAt, queueDelayMs, merged:job.merged, manual:job.manual });
  }, undefined, undefined, () => console.error('Exam monitor task failed; inspect storage and configuration.'));
  let syncing=false;
  const sync = async () => {
    if(syncing) return; syncing=true;
    try {
      await store.exams.updateMany({ active:true, autoStop:{$ne:false}, endAt:{$lte:new Date()} },{$set:{active:false}});
      const exams = await store.exams.find({active:true}).toArray(); const wanted = new Set<string>();
      for(const exam of exams) {
        for(const mapping of exam.mappings) { const id=`${exam._id}/${mapping.studentId}`; wanted.add(id); tasks.set(id,{exam,...mapping}); scheduler.add(id); }
        const claimed = await store.exams.findOneAndUpdate({_id:exam._id},{$set:{manual:[]}},{returnDocument:'before'});
        for(const id of claimed?.manual ?? []) if(wanted.has(id)) scheduler.manual(id);
      }
      for(const id of tasks.keys()) if(!wanted.has(id)){scheduler.remove(id);tasks.delete(id);}
      const state=scheduler.snapshot();
      for(const exam of exams) {
        const runtime=state.filter(s=>s.id.startsWith(`${exam._id}/`)).map(s=>({studentId:Number(s.id.slice(s.id.lastIndexOf('/')+1)),running:s.running,pending:!!s.pending,queueDelayMs:s.pending?Math.max(0,performance.now()-s.pending.planned):0,merged:s.pending?.merged??0}));
        await store.exams.updateOne({_id:exam._id},{$set:{runtime,collectorSeenAt:Date.now()} as any});
      }
    } finally {syncing=false;}
  };
  if(process.env.EXAM_MONITOR_COLLECTOR === '1') {
    await sync(); const tick=setInterval(()=>scheduler.tick(),50);
    const poll=setInterval(()=>void sync().catch(()=>console.error('Exam monitor sync failed')),1000);
    const cleanup=setInterval(()=>void store.clean().catch(()=>console.error('Exam monitor cleanup failed')),3600000);
    ctx.effect(()=>()=>{clearInterval(tick);clearInterval(poll);clearInterval(cleanup);scheduler.stop();});
  }
  // Build a seat mapping from each account's most recent login IP (BYOD / DHCP friendly).
  const buildLoginMappings=async(prefix:string,minutes:number)=>{
    const localIps=new Set<string>(); for(const list of Object.values(os.networkInterfaces())) for(const a of list??[]) if(a?.address) localIps.add(a.address);
    const now=Date.now();
    const pattern='^'+prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\d+$';
    const users=await ctx.db.db.collection('user').find({uname:{$regex:pattern}}).project({uname:1,loginip:1,loginat:1}).toArray();
    const byIp=new Map<string,{uid:number;at:number}>();
    let skipped=0;
    for(const u of users){
      const ip=String(u.loginip??'');
      if(!ip||localIps.has(ip)||ip.endsWith('.1')){skipped++;continue;}
      if(!registry.has('ip-'+ip.replace(/\./g,'-'))){skipped++;continue;}
      const at=u.loginat?new Date(u.loginat as any).getTime():0;
      if(now-at>minutes*60000){skipped++;continue;}
      const prev=byIp.get(ip);
      if(prev&&prev.at>=at){skipped++;continue;}
      byIp.set(ip,{uid:u._id as number,at});
    }
    const mappings=validMappings([...byIp.entries()].map(([ip,r])=>({studentId:r.uid,deviceId:'ip-'+ip.replace(/\./g,'-')})),new Set(registry.keys()));
    return {mappings,skipped};
  };
  class MonitorHandler extends Handler {
    private examKey=''; private contestId=''; private contestTitle=''; private endAt=new Date();
    @param('tid',Types.ObjectId)
    async prepare(domainId:string,tid:ObjectId) {
      const contest=await ContestModel.get(domainId,tid);
      if(!contest || !mayManage({id:this.user._id,edit:this.user.hasPerm(PERM.PERM_EDIT_CONTEST),editSelf:this.user.hasPerm(PERM.PERM_EDIT_CONTEST_SELF)},contest)) throw new ForbiddenError('Contest management required');
      this.contestId=tid.toHexString();this.contestTitle=String(contest.title??'');this.examKey=`${domainId}/${this.contestId}`;this.endAt=contest.endAt;
    }
    private async ensureMappings() {
      const exam = await store.exams.findOne({ _id: this.examKey });
      if (exam?.mappings?.length) return;
      const { mappings } = await buildLoginMappings('seat', 120);
      if (!mappings.length) return;
      await store.exams.updateOne({ _id: this.examKey }, {
        $set: {
          domainId: this.args.domainId, contestId: this.contestId, endAt: this.endAt,
          mappings, active: false, manual: [],
        },
      }, { upsert: true });
      console.log(`exam-monitor: auto-mapped ${mappings.length} seats for ${this.examKey}`);
    }
    async get() {
      const query=this.request.query;
      if(query.image) {
        if(!ObjectId.isValid(String(query.image))) throw new ForbiddenError('Invalid image');
        const row=await store.results.findOne({_id:new ObjectId(String(query.image)),examId:this.examKey});
        if(!row?.path) throw new ForbiddenError('Image unavailable');
        this.response.type='image/jpeg';this.response.body=createReadStream(row.path);return;
      }
      if(query.history) { const studentId=Number(query.history);const rows=await store.results.find({examId:this.examKey,studentId,path:{$exists:true}}).sort({completedAt:-1}).limit(100).project({path:0}).toArray();this.response.body={rows};return; }
      if(query.status) {
        const exam=await store.exams.findOne({_id:this.examKey});
        const rows=await store.results.aggregate([{$match:{examId:this.examKey}},{$sort:{completedAt:-1}},{$group:{_id:'$studentId',latest:{$first:'$$ROOT'}}},{$project:{'latest.path':0}}]).toArray();
        const successes=await store.results.aggregate([{$match:{examId:this.examKey,path:{$exists:true}}},{$group:{_id:'$studentId',lastSuccessAt:{$max:'$completedAt'}}}]).toArray();
        const deviceIds=(exam?.mappings??[]).map((m:any)=>m.deviceId);
        const agentRows=deviceIds.length?await agents.find({_id:{$in:deviceIds}}).toArray():[];
        this.response.body={active:exam?.active??false,mappings:exam?.mappings??[],runtime:(exam as any)?.runtime??[],collectorSeenAt:(exam as any)?.collectorSeenAt??null,successes,rows,agents:agentRows};return;
      }
      // A brand-new contest has no mapping yet. Fill it from the students' most recent
      // logins so the operator can go straight to "start" without importing anything.
      try { await this.ensureMappings(); } catch (e) { console.error('exam-monitor: auto mapping failed', e); }
      this.response.template='exam_monitor.html';this.response.body={monitorTitle:this.contestTitle};
    }
    async post() {
      const body=this.request.body; const action=body.action;
      if(action==='import') {
        let parsed: unknown;
        try { parsed=typeof body.mappings==='string'?JSON.parse(body.mappings):body.mappings; }
        catch { throw new ValidationError('mappings'); }
        if(!Array.isArray(parsed)) throw new ValidationError('mappings');
        const mappings=validMappings(parsed as any,new Set(registry.keys()));
        if((await store.exams.findOne({_id:this.examKey}))?.active) throw new ForbiddenError('Stop monitoring before changing mappings');
        await store.exams.updateOne({_id:this.examKey},{$set:{domainId:this.args.domainId,contestId:this.contestId,endAt:this.endAt,mappings,active:false,manual:[]}},{upsert:true});
      } else if(action==='importFromLogin') {
        // Same builder as the automatic fill; kept as an explicit action so the operator can
        // refresh the mapping after students have (re)logged in.
        if((await store.exams.findOne({_id:this.examKey}))?.active) throw new ForbiddenError('Stop monitoring before changing mappings');
        const minutes=Number(body.minutes)>0?Number(body.minutes):120;
        const prefix=typeof body.prefix=== 'string'&&body.prefix?body.prefix:'seat';
        const {mappings,skipped}=await buildLoginMappings(prefix,minutes);
        if(!mappings.length) throw new ForbiddenError('No recent logins found - ask students to log in to the OJ first');
        await store.exams.updateOne({_id:this.examKey},{$set:{domainId:this.args.domainId,contestId:this.contestId,endAt:this.endAt,mappings,active:false,manual:[]}},{upsert:true});
        this.response.body={ok:true,imported:mappings.length,skipped,message:'已按登录 IP 导入 '+mappings.length+' 条映射'+(skipped?'（跳过 '+skipped+' 个账号）':'')};
        return;
      } else if(action==='start' || action==='stop') {
        let exam=await store.exams.findOne({_id:this.examKey});
        if(action==='start' && !exam?.mappings?.length) { await this.ensureMappings(); exam=await store.exams.findOne({_id:this.examKey}); }
        if(!exam?.mappings?.length) throw new ForbiddenError('No mapping: ask students to log in to the OJ first, or import the mapping JSON by hand');
        if(action==='start') {
          const used=await store.exams.find({active:true,_id:{$ne:this.examKey},'mappings.deviceId':{$in:exam.mappings.map(m=>m.deviceId)}}).hasNext();
          if(used) throw new ForbiddenError('Device already assigned to active exam');
          // Monitoring is started/stopped by hand at any time. autoStop=true (default) ends it at the
          // contest end time; autoStop=false keeps it running until the operator stops it.
          const autoStop=body.autoStop!==false;
          let endAt=this.endAt;
          if(autoStop && endAt.getTime()<=Date.now()) endAt=new Date(Date.now()+12*3600e3);
          await store.exams.updateOne({_id:this.examKey},{$set:{active:true,endAt,autoStop}});
        } else {
          await store.exams.updateOne({_id:this.examKey},{$set:{active:false}});
        }
      } else if(action==='capture') {
        const studentId=Number(body.studentId);const exam=await store.exams.findOne({_id:this.examKey,active:true});
        if(!exam?.mappings.some(m=>m.studentId===studentId)) throw new ForbiddenError('Student not monitored');
        await store.exams.updateOne({_id:this.examKey},{$addToSet:{manual:`${this.examKey}/${studentId}`}});
      } else throw new ForbiddenError('Unknown action');
      this.response.body={ok:true};
    }
  }
  class ReportHandler extends Handler {
    noCheckPermView = true;
    notUsage = true;
    async post() {
      const token = String(this.request.headers['x-exam-token'] ?? '');
      const deviceId = tokenDevice.get(token);
      if (!deviceId) throw new ForbiddenError('Invalid report token');
      const body = (this.request.body ?? {}) as any;
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 300).map((i: any) => ({
        n: String(i?.n ?? '').slice(0, 120), t: String(i?.t ?? '').slice(0, 200), m: Number(i?.m) || 0, p: Number(i?.p) || 0,
      })).filter((i: any) => i.n);
      const rules = await loadRules();
      const suspects = items.filter((i: any) => rules.some((r) => r.test(i.n) || r.test(i.t)))
        .map((i: any) => ({ n: i.n, t: i.t, p: i.p }));
      const events = (Array.isArray(body.events) ? body.events : []).slice(0, 50).map((e: any) => ({
        n: String(e?.n ?? '').slice(0, 120), t: String(e?.t ?? '').slice(0, 200),
        act: e?.act === 'stop' ? 'stop' : 'start', at: Number(e?.at) || Date.now(),
      }));
      await agents.updateOne({ _id: deviceId } as any, {
        $set: {
          at: Date.now(), host: String(body.host ?? '').slice(0, 64), user: String(body.user ?? '').slice(0, 64),
          ip: String(body.ip ?? '').slice(0, 64), items, suspects,
        },
        $push: { events: { $each: events, $slice: -30 } } as any,
      }, { upsert: true });
      this.response.body = { ok: true };
    }
  }
  ctx.Route('exam_report', '/exam-report', ReportHandler);
  ctx.Route('exam_monitor','/exam-monitor/:tid',MonitorHandler);
}
