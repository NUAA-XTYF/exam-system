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
  class MonitorHandler extends Handler {
    private examKey=''; private contestId=''; private contestTitle=''; private endAt=new Date();
    @param('tid',Types.ObjectId)
    async prepare(domainId:string,tid:ObjectId) {
      const contest=await ContestModel.get(domainId,tid);
      if(!contest || !mayManage({id:this.user._id,edit:this.user.hasPerm(PERM.PERM_EDIT_CONTEST),editSelf:this.user.hasPerm(PERM.PERM_EDIT_CONTEST_SELF)},contest)) throw new ForbiddenError('Contest management required');
      this.contestId=tid.toHexString();this.contestTitle=String(contest.title??'');this.examKey=`${domainId}/${this.contestId}`;this.endAt=contest.endAt;
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
        this.response.body={active:exam?.active??false,mappings:exam?.mappings??[],runtime:(exam as any)?.runtime??[],collectorSeenAt:(exam as any)?.collectorSeenAt??null,successes,rows};return;
      }
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
        // Build the mapping from each account's most recent login IP. Works for BYOD
        // laptops where the MAC address is unknown and IPs are handed out by DHCP.
        if((await store.exams.findOne({_id:this.examKey}))?.active) throw new ForbiddenError('Stop monitoring before changing mappings');
        const minutes=Number(body.minutes)>0?Number(body.minutes):120;
        const prefix=typeof body.prefix==='string'&&body.prefix?body.prefix:'seat';
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
        if(!mappings.length) throw new ForbiddenError('No recent logins found - ask students to log in to the OJ first');
        await store.exams.updateOne({_id:this.examKey},{$set:{domainId:this.args.domainId,contestId:this.contestId,endAt:this.endAt,mappings,active:false,manual:[]}},{upsert:true});
        this.response.body={ok:true,imported:mappings.length,skipped,message:'已按登录 IP 导入 '+mappings.length+' 条映射'+(skipped?'（跳过 '+skipped+' 个账号）':'')};
        return;
      } else if(action==='start' || action==='stop') {
        const exam=await store.exams.findOne({_id:this.examKey});if(!exam?.mappings.length) throw new ForbiddenError('Import mappings first');
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
  ctx.Route('exam_monitor','/exam-monitor/:tid',MonitorHandler);
}
