import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,readFile,rm,chmod} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {launchSubagent,sendSubagentMessage,resumeSubagent,waitForSubagent,cancelSubagent,getSubagentStatus} from "../src/run.js";
import type {AgentConfig} from "../src/types.js";

// Exercise the real tmux/CLI/bootstrap boundary without invoking a model provider.
test("real tmux preserves a child's session, results and usage through send, stop and resume",async()=>{
  const root=await mkdtemp(join(tmpdir(),"subagent-functional-"));
  const original={...process.env};
  const jobs:string[]=[];
  for(const key of ["PI_AGENT_HUB_DIR","PI_AGENT_HUB_SESSION_ID","PI_TMUX_SUBAGENTS_PARENT_ID","PI_TMUX_SUBAGENTS_JOB_ID"])delete process.env[key];
  const executable=join(root,"fixture-pi.mjs");
  const bootstrap=new URL("../src/child-bootstrap.js",import.meta.url).href;
  const script=`#!${process.execPath}
import fs from 'node:fs/promises';
import {join} from 'node:path';
import bootstrap from ${JSON.stringify(bootstrap)};
const args=process.argv.slice(2), root=process.env.PI_TMUX_SUBAGENTS_DIR, id=process.env.PI_TMUX_SUBAGENTS_JOB_ID;
const sessionFile=args.includes('--session')?args[args.indexOf('--session')+1]:join(root,'jobs',id,'session.jsonl');
let entries=[],sessionId=id+'-pi';
if(args.includes('--session')) {const all=(await fs.readFile(sessionFile,'utf8')).trim().split('\\n').map(JSON.parse);sessionId=all[0].id;entries=all.slice(1);}
else await fs.writeFile(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()})+'\\n');
const handlers={},context={cwd:process.cwd(),isIdle:()=>true,model:{provider:'fixture',id:'model'},thinkingLevel:'off',ui:{notify:console.error},shutdown:()=>{closing=true;},sessionManager:{getEntries:()=>entries,getSessionFile:()=>sessionFile,getSessionId:()=>sessionId}};
let closing=false;
bootstrap({on:(name,fn)=>{handlers[name]=fn;},getThinkingLevel:()=> 'off'});
await handlers.session_start({reason:'startup'},context);
async function append(entry){entries.push(entry);await fs.appendFile(sessionFile,JSON.stringify(entry)+'\\n');}
async function run(message){
  await handlers.agent_start({},context);
  await append({type:'message',id:'u'+entries.length,message:{role:'user',content:message}});
  const assistant={role:'assistant',content:[{type:'text',text:'Completed: '+message}],stopReason:'stop',usage:{input:10,output:2,cacheRead:3,cacheWrite:0,totalTokens:15,cost:{input:0.01,output:0.002,cacheRead:0.001,cacheWrite:0,total:0.013}}};
  await append({type:'message',id:'a'+entries.length,message:assistant});
  await handlers.turn_end({},context);await handlers.agent_end({messages:[assistant]},context);await handlers.agent_settled({},context);
  if(closing){await handlers.session_shutdown({},context);process.exit(0);}
}
await run((await fs.readFile(args.at(-1).slice(1),'utf8')).trimEnd());
process.stdout.write('\\x1b[?2004h');process.stdin.setRawMode(true);process.stdin.resume();
let buffer='';
process.stdin.on('data',async data=>{buffer+=data.toString();if(!buffer.endsWith('\\r'))return;const message=buffer.slice(0,-1).replace(/\\x1b\\[20[01]~/g,'');buffer='';await run(message);});
`;
  await writeFile(executable,script);await chmod(executable,0o755);
  process.env.PI_TMUX_SUBAGENTS_PI_BIN=executable;
  const agent:AgentConfig={name:"fixture",description:"Fixture",source:"user",filePath:"fixture.md",systemPrompt:"Fixture only",systemPromptMode:"replace",inheritProjectContext:false,inheritSkills:false,tools:"none",thinking:"off",maxDepth:0};
  try {
    const job=await launchSubagent({stateRoot:root,cwd:root,agent,task:"Initial task",background:true,autoStopOnComplete:false});jobs.push(job.id);
    const first=await waitForSubagent(root,job.id,undefined,{afterTurnIndex:0,intervalMs:20,timeoutMs:10000});
    assert.equal(first.latestTurn?.index,1);assert.equal(first.usage?.cost.total,0.013);
    // Waiting publication precedes entering the fixture's input loop by a few microtasks.
    await new Promise(resolve=>setTimeout(resolve,80));
    await sendSubagentMessage(root,job.id,"Follow up");
    const second=await waitForSubagent(root,job.id,undefined,{afterTurnIndex:1,intervalMs:20,timeoutMs:10000});
    assert.equal(second.latestTurn?.index,2);assert.equal(second.usage?.cost.total,0.026);
    const savedSession=second.job.sessionFile;
    assert.ok(savedSession);assert.equal(second.job.resolvedThinking,"off");
    await cancelSubagent(root,job.id);
    const resumed=await resumeSubagent(root,job.id,"Resume follow-up");
    assert.equal(resumed.sessionFile,savedSession);
    const third=await waitForSubagent(root,job.id,undefined,{afterTurnIndex:2,executionId:resumed.executionId,intervalMs:20,timeoutMs:10000});
    assert.equal(third.latestTurn?.index,3);assert.equal(third.usage?.cost.total,0.039);assert.equal(third.latestTurn?.usage?.cost.total,0.013);
    const entries=(await readFile(savedSession!,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(entries.filter(e=>e.message?.role==="user").length,3);
    assert.equal(entries.at(-2).message.content,"Resume follow-up");
    assert.match(await readFile(third.resultPath!,"utf8"),/Resume follow-up/);
    const one=await launchSubagent({stateRoot:root,cwd:root,agent,task:"One shot",background:true,autoStopOnComplete:true});jobs.push(one.id);
    await waitForSubagent(root,one.id,undefined,{afterTurnIndex:0,intervalMs:20,timeoutMs:10000});
    for(let i=0;i<100;i++){if((await getSubagentStatus(root,one.id)).autoStopped)break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal((await getSubagentStatus(root,one.id)).autoStopped,true);
    const oneResumed=await resumeSubagent(root,one.id,"One more shot");
    const again=await waitForSubagent(root,one.id,undefined,{afterTurnIndex:1,executionId:oneResumed.executionId,intervalMs:20,timeoutMs:10000});
    assert.equal(again.latestTurn?.index,2);
    for(let i=0;i<100;i++){if((await getSubagentStatus(root,one.id)).autoStopped)break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal((await getSubagentStatus(root,one.id)).autoStopped,true);
  } finally {
    for(const id of jobs)await cancelSubagent(root,id);
    process.env=original;await rm(root,{recursive:true,force:true});
  }
});
