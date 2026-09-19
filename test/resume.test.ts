import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSubagent, resumeSubagent, getSubagentStatus, cancelSubagent, waitForSubagent } from "../src/run.js";
import { loadJobs, updateJob } from "../src/state.js";
import { turnsDir, turnsPath } from "../src/paths.js";
import type { AgentConfig } from "../src/types.js";
import type { TmuxExecutor } from "../src/tmux.js";

const agent: AgentConfig = { name: "worker", description: "Worker", source: "user", filePath: "/unused", systemPrompt: "Keep scope narrow.", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false, tools: ["read"], model: "openai/test", thinking: "off", maxDepth: 0 };
async function fixture(fn: (x: {root: string; id: string; sessionFile: string; calls: string[][]; tmux: TmuxExecutor; setLive: (x: boolean) => void}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "subagent-resume-"));
  const env = { ...process.env };
  for (const k of ["PI_AGENT_HUB_DIR", "PI_AGENT_HUB_SESSION_ID", "PI_TMUX_SUBAGENTS_PARENT_ID", "PI_TMUX_SUBAGENTS_JOB_ID"]) delete process.env[k];
  const calls: string[][] = []; let live = false;
  const tmux: TmuxExecutor = async args => {
    calls.push(args);
    if (args[0] === "has-session" && !live) throw Object.assign(new Error("missing"), { stderr: "can't find session" });
    if (args[0] === "new-session") live = true;
    if (args[0] === "kill-session") live = false;
    return {stdout: "", stderr: ""};
  };
  try {
    const job = await launchSubagent({stateRoot:root,cwd:root,agent,task:"First task",background:true,tmux});
    const sessionFile = join(root,"session.jsonl");
    await writeFile(sessionFile, JSON.stringify({type:"session",version:3,id:"session-1",cwd:root})+"\n");
    await updateJob(root,job.id,j=>({...j,status:"stopped",autoStopped:true,sessionFile,sessionId:"session-1",resolvedModel:"openai/test",resolvedThinking:"off"}));
    live = false; calls.length = 0;
    await fn({root,id:job.id,sessionFile,calls,tmux,setLive:x=>{live=x;}});
  } finally { process.env = env; await rm(root,{recursive:true,force:true}); }
}

test("resume retains identity, uses saved session and submits only the follow-up", async()=>fixture(async x=>{
  const before = (await loadJobs(x.root)).jobs[0]!;
  const resumed = await resumeSubagent(x.root,x.id,"Check the revised patch.\nKeep it brief.",x.tmux);
  assert.equal(resumed.id,before.id);
  assert.equal(resumed.createdAt,before.createdAt);
  assert.equal(resumed.sessionFile,x.sessionFile);
  assert.notEqual(resumed.executionId,before.executionId);
  assert.equal(resumed.autoStopped,undefined);
  assert.equal(resumed.launchPending,undefined);
  const command=x.calls.find(c=>c[0]==="new-session")!.at(-1)!;
  assert.ok(command.includes(x.sessionFile));
  assert.match(command,/--session/);
  assert.match(command,/--thinking' 'off/);
  assert.ok(!command.includes("/task.md"));
  assert.equal(await readFile(join(x.root,"jobs",x.id,"resume.md"),"utf8"),"Check the revised patch.\nKeep it brief.\n");
}));

test("resume wait rejects an exit before a fresh result and a replacement execution", async () => fixture(async x => {
  const resumed = await resumeSubagent(x.root, x.id, "Next", x.tmux);
  const options = { afterTurnIndex: 1, executionId: resumed.executionId, intervalMs: 1, timeoutMs: 100 };
  const resultFile = join(x.root, "old-result.md");
  await writeFile(resultFile, "Old result");
  await mkdir(turnsDir(x.root, x.id), { recursive: true });
  await writeFile(turnsPath(x.root, x.id), JSON.stringify({ version: 1, turns: [
    { index: 1, executionId: "old", resultPath: resultFile, status: "waiting", startedAt: 1 },
  ] }));
  x.setLive(false);
  await assert.rejects(waitForSubagent(x.root, x.id, x.tmux, options), /stopped before completing/);
  await updateJob(x.root, x.id, job => ({ ...job, executionId: "replacement", status: "running" }));
  x.setLive(true);
  await assert.rejects(waitForSubagent(x.root, x.id, x.tmux, options), /execution changed/);
  await updateJob(x.root, x.id, job => ({ ...job, executionId: resumed.executionId, status: "stopped" }));
  await writeFile(turnsPath(x.root, x.id), JSON.stringify({ version: 1, turns: [
    { index: 2, executionId: resumed.executionId, resultPath: resultFile, status: "waiting", startedAt: 2 },
  ] }));
  x.setLive(false);
  assert.equal((await waitForSubagent(x.root, x.id, x.tmux, options)).latestTurn?.index, 2);
}));

test("resume rejects live children and missing or mismatched session records",async()=>fixture(async x=>{
  x.setLive(true);
  await assert.rejects(resumeSubagent(x.root,x.id,"Next",x.tmux),/live|running|send/i);
  x.setLive(false);
  await assert.rejects(resumeSubagent(x.root,x.id,"  ",x.tmux),/message/i);
  await writeFile(x.sessionFile,JSON.stringify({type:"session",id:"wrong"})+"\n");
  await assert.rejects(resumeSubagent(x.root,x.id,"Next",x.tmux),/identity|session/i);
  await rm(x.sessionFile);
  await assert.rejects(resumeSubagent(x.root,x.id,"Next",x.tmux),/ENOENT|session/i);
  assert.equal(x.calls.filter(c=>c[0]==="new-session").length,0);
}));

test("resume fails before dispatch when saved identity, cwd or launch files are unavailable", async () => fixture(async x => {
  const original = (await loadJobs(x.root)).jobs[0]!;
  for (const patch of [{ sessionId: undefined }, { cwd: join(x.root, "missing-cwd") }]) {
    await updateJob(x.root, x.id, () => ({ ...original, ...patch }));
    await assert.rejects(resumeSubagent(x.root, x.id, "Next", x.tmux), /metadata|ENOENT/);
  }
  await updateJob(x.root, x.id, () => original);
  const system = join(x.root, "jobs", x.id, "agent-system.md");
  const saved = await readFile(system, "utf8");
  await rm(system);
  await assert.rejects(resumeSubagent(x.root, x.id, "Next", x.tmux), /ENOENT/);
  await writeFile(system, saved);
  await rm(join(x.root, "jobs", x.id, "metadata.json"));
  await assert.rejects(resumeSubagent(x.root, x.id, "Next", x.tmux), /ENOENT/);
  assert.equal(x.calls.filter(c => c[0] === "new-session").length, 0);
  assert.equal((await loadJobs(x.root)).jobs[0]!.executionId, original.executionId);
}));

test("resume transfers Hub ownership and clears old mirrors when returning to standalone",async()=>fixture(async x=>{
  const oldHub=join(x.root,"old-hub"),newHub=join(x.root,"new-hub");
  for(const [dir,parentId] of [[oldHub,"old-parent"],[newHub,"new-parent"]]) {
    await mkdir(join(dir!,"heartbeats"),{recursive:true});
    await writeFile(join(dir!,"registry.json"),JSON.stringify({version:1,sessions:[{id:parentId,title:"Parent",group:"work"}]}));
  }
  await writeFile(join(oldHub,"registry.json"),JSON.stringify({version:1,sessions:[{id:"old-parent",group:"work"},{id:x.id,parentId:"old-parent"}]}));
  await writeFile(join(oldHub,"heartbeats",`${x.id}.json`),"{}");
  await updateJob(x.root,x.id,j=>({...j,hubDir:oldHub,parentId:"old-parent"}));
  process.env.PI_AGENT_HUB_DIR=newHub;process.env.PI_AGENT_HUB_SESSION_ID="new-parent";
  const resumed=await resumeSubagent(x.root,x.id,"Move to new parent",x.tmux);
  assert.equal(resumed.parentId,"new-parent");assert.equal(resumed.hubDir,newHub);
  const old=JSON.parse(await readFile(join(oldHub,"registry.json"),"utf8"));
  assert.ok(!old.sessions.some((s:any)=>s.id===x.id));
  await assert.rejects(readFile(join(oldHub,"heartbeats",`${x.id}.json`)),{code:"ENOENT"});
  const current=JSON.parse(await readFile(join(newHub,"registry.json"),"utf8"));
  assert.equal(current.sessions.find((s:any)=>s.id===x.id).parentId,"new-parent");
  await updateJob(x.root,x.id,j=>({...j,status:"stopped",autoStopped:true}));x.setLive(false);
  delete process.env.PI_AGENT_HUB_DIR;delete process.env.PI_AGENT_HUB_SESSION_ID;
  const standalone=await resumeSubagent(x.root,x.id,"Move to standalone",x.tmux);
  assert.equal(standalone.hubDir,undefined);assert.equal(standalone.parentId,undefined);
  assert.ok(!JSON.parse(await readFile(join(newHub,"registry.json"),"utf8")).sessions.some((s:any)=>s.id===x.id));
  assert.match(x.calls.filter(c=>c[0]==="new-session").at(-1)!.at(-1)!,/PI_AGENT_HUB_DIR=''/);
}));

test("resume does not restart stopped descendants",async()=>fixture(async x=>{
  const registry=await loadJobs(x.root);
  registry.jobs.push({...registry.jobs[0]!,id:"descendant",parentId:x.id,tmuxSession:"descendant",status:"stopped"});
  await writeFile(join(x.root,"jobs.json"),JSON.stringify(registry));
  await resumeSubagent(x.root,x.id,"Only parent",x.tmux);
  assert.equal((await loadJobs(x.root)).jobs.find(j=>j.id==="descendant")!.status,"stopped");
  assert.equal(x.calls.filter(c=>c[0]==="new-session").length,1);
}));

test("resume does not treat a tmux query failure as proof the child is stopped",async()=>fixture(async x=>{
  await assert.rejects(resumeSubagent(x.root,x.id,"Next",async()=>{throw new Error("tmux permission denied");}),/permission denied/);
}));

test("concurrent resume calls dispatch once",async()=>fixture(async x=>{
  const results=await Promise.allSettled([resumeSubagent(x.root,x.id,"One",x.tmux),resumeSubagent(x.root,x.id,"Two",x.tmux)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(x.calls.filter(c=>c[0]==="new-session").length,1);
}));

test("polling during spawn preserves starting and stop waits for spawn before killing",async()=>fixture(async x=>{
  let stop: Promise<unknown> | undefined;
  const resumed=await resumeSubagent(x.root,x.id,"Next",async args=>{
    if(args[0]==="new-session") {
      const polled=await getSubagentStatus(x.root,x.id,x.tmux);
      assert.equal(polled.status,"starting");
      assert.equal(polled.job.launchPending,true);
      stop=cancelSubagent(x.root,x.id,x.tmux);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    return x.tmux(args);
  });
  await stop;
  const job=(await loadJobs(x.root)).jobs[0]!;
  assert.equal(job.status,"stopped");
  assert.notEqual(job.executionId,resumed.executionId);
  assert.equal(x.calls.filter(c=>c[0]==="new-session").length,1);
  assert.equal(x.calls.filter(c=>c[0]==="kill-session").length,1);
}));

test("spawn failure preserves saved session and permits explicit retry",async()=>fixture(async x=>{
  await assert.rejects(resumeSubagent(x.root,x.id,"Next",async args=>{if(args[0]==="new-session")throw new Error("spawn failed");return x.tmux(args);}),/spawn failed/);
  const failed=(await loadJobs(x.root)).jobs[0]!;
  assert.equal(failed.launchPending,undefined);
  assert.equal(failed.sessionFile,x.sessionFile);
  assert.equal(failed.status,"error");
  await resumeSubagent(x.root,x.id,"Retry",x.tmux);
}));

test("explicit stop preserves reported lifetime usage after the last successful result",async()=>fixture(async x=>{
  const job=await updateJob(x.root,x.id,j=>({...j,status:"running",autoStopped:undefined}));
  const usage={input:20,output:4,cacheRead:0,cacheWrite:0,totalTokens:24,cost:{input:0.02,output:0.004,cacheRead:0,cacheWrite:0,total:0.024}};
  await writeFile(join(x.root,"jobs",x.id,"heartbeat.json"),JSON.stringify({executionId:job.executionId,state:"error",lifetimeUsage:usage}));
  x.setLive(true);
  await cancelSubagent(x.root,x.id,x.tmux);
  const stopped=await getSubagentStatus(x.root,x.id,x.tmux);
  assert.equal(stopped.status,"stopped");assert.equal(stopped.usageScope,"lifetime");assert.equal(stopped.usage?.cost.total,0.024);
}));

test("polling preserves pending claim, and explicit stop clears a stranded claim",async()=>fixture(async x=>{
  await updateJob(x.root,x.id,j=>({...j,status:"starting",autoStopped:undefined,launchPending:true}));
  assert.equal((await getSubagentStatus(x.root,x.id,x.tmux)).status,"starting");
  await assert.rejects(resumeSubagent(x.root,x.id,"Again",x.tmux),/pending|starting/i);
  await cancelSubagent(x.root,x.id,x.tmux);
  assert.equal((await loadJobs(x.root)).jobs[0]!.launchPending,undefined);
}));
