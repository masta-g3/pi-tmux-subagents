import assert from "node:assert/strict";
import test from "node:test";
import fs, {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {getSubagentStatuses,getSubagentStatus} from "../src/run.js";
import {updateJob} from "../src/state.js";
import type {TmuxSubagentJob} from "../src/types.js";

async function fixture(count: number, fn:(root:string,jobs:TmuxSubagentJob[])=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),"subagent-observation-"));
  const jobs:TmuxSubagentJob[]=Array.from({length:count},(_,i)=>({id:`child-${i}`,agentName:"worker",taskPreview:"Task",cwd:root,tmuxSession:`child-${i}`,status:"running",executionId:`run-${i}`,createdAt:1,updatedAt:1,resultPath:join(root,"jobs",`child-${i}`,"result.md")}));
  try {
    await writeFile(join(root,"jobs.json"),JSON.stringify({version:1,jobs}));
    for(const job of jobs.slice(0,20)) {
      await mkdir(join(root,"jobs",job.id),{recursive:true});
      await writeFile(join(root,"jobs",job.id,"heartbeat.json"),JSON.stringify({executionId:job.executionId,state:"running",seenRunning:true}));
      await writeFile(job.resultPath,"Large result ".repeat(1000));
    }
    await fn(root,jobs);
  } finally {await rm(root,{recursive:true,force:true});}
}

test("a stable status page shares two registry reads and skips result bodies and terminal captures",async t=>{
  for(const size of [1,7300]) await fixture(size,async(root,jobs)=>{
    let registryReads=0,bodyReads=0,captures=0;
    const read=fs.readFile;
    t.mock.method(fs,"readFile",async (...args:Parameters<typeof fs.readFile>)=>{
      if(String(args[0])===join(root,"jobs.json"))registryReads++;
      if(String(args[0]).endsWith("result.md"))bodyReads++;
      return read(...args);
    });
    syncBuiltinESMExports();
    try {
      const selected=jobs.slice(0,20);
      const results=await getSubagentStatuses(root,selected.map(j=>j.id),async args=>{if(args[0]==="capture-pane")captures++;return {stdout:"",stderr:""};});
      assert.equal(results.length,selected.length);
      assert.ok(results.every(r=>r.status==="fulfilled"&&r.value.status==="running"&&!!r.value.resultPath));
      assert.equal(registryReads,2);
      assert.equal(bodyReads,0);
      assert.equal(captures,0);
    } finally {t.mock.restoreAll();syncBuiltinESMExports();}
  });
});

test("batch reconciliation does not overwrite a resumed execution or auto-stop",async()=>fixture(2,async(root,jobs)=>{
  const results=await getSubagentStatuses(root,jobs.map(j=>j.id),async args=>{
    const job=jobs.find(j=>j.tmuxSession===args[2])!;
    if(job.id==="child-0") await updateJob(root,job.id,j=>({...j,executionId:"resumed",status:"starting",launchPending:true}));
    else await updateJob(root,job.id,j=>({...j,autoStopped:true,status:"stopped"}));
    return {stdout:"",stderr:""};
  });
  assert.equal(results[0]!.status,"fulfilled");
  const first=(results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof getSubagentStatus>>>).value;
  assert.equal(first.status,"starting"); assert.equal(first.heartbeat,undefined); assert.equal(first.resultPath,undefined);
  assert.equal((results[1] as PromiseFulfilledResult<typeof first>).value.status,"stopped");
}));

test("stale heartbeat is ignored and one bad child does not hide other observations",async()=>fixture(2,async(root,jobs)=>{
  await writeFile(join(root,"jobs",jobs[0]!.id,"heartbeat.json"),JSON.stringify({executionId:"old",state:"waiting",seenRunning:true}));
  await writeFile(join(root,"jobs",jobs[1]!.id,"heartbeat.json"),"invalid JSON");
  const results=await getSubagentStatuses(root,jobs.map(j=>j.id),async()=>({stdout:"",stderr:""}));
  assert.equal(results[0]!.status,"fulfilled");
  assert.equal((results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof getSubagentStatus>>>).value.heartbeat,undefined);
  assert.equal(results[1]!.status,"rejected");
}));
