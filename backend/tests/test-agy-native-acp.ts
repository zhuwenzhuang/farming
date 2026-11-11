import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from '../acp-runtime.cjs';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agy-native-'));
  const executable = path.join(root, 'agy');
  const runtime = new AcpRuntime();
  try {
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs'), path = require('path'), readline = require('readline');
const args = process.argv.slice(2);
if (args[0] !== 'acp' || !args.includes('--stdio') || args.includes('-p') || args.includes('models')) process.exit(2);
const home = path.join(args[args.indexOf('--gemini_dir')+1], args[args.indexOf('--app_data_dir')+1]);
const models = JSON.parse(fs.readFileSync(path.join(home,'catalog.json')));
const sessions = new Map(), pending = new Map();
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const modeOptions = ['default','accept-edits','auto','plan'].map(value=>({value,name:value}));
const config = state => [
 {id:'model',name:'Model',category:'model',type:'select',currentValue:state.model,options:models.map(value=>({value,name:value}))},
 {id:'thought_level',name:'Thinking Level',category:'thought_level',type:'select',currentValue:state.effort,options:[{value:'provider-effort',name:'Provider effort'}]},
 {id:'mode',name:'Mode',category:'mode',type:'select',currentValue:state.mode,options:modeOptions}];
readline.createInterface({input:process.stdin}).on('line', line=>{
 const req=JSON.parse(line), p=req.params||{};let result={};
 if(req.method==='initialize') result={protocolVersion:1,agentInfo:{name:'Antigravity ACP Server',version:'1.5.5'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}};
 else if(['session/new','session/load','session/resume'].includes(req.method)) {
  const id=p.sessionId||require('crypto').randomUUID();
  const state=p.sessionId?JSON.parse(fs.readFileSync(path.join(home,id+'.json'))):{model:models[0],effort:'provider-effort',mode:'default'};
  if(p._meta?.antigravity?.systemPrompt?.append!=='native bootstrap') throw Error('missing native system metadata');
  sessions.set(id,state);fs.writeFileSync(path.join(home,id+'.json'),JSON.stringify(state));
  result={sessionId:id,configOptions:config(state),modes:{currentModeId:state.mode,availableModes:modeOptions.map(x=>({id:x.value,name:x.name}))}};
 } else if(req.method==='session/set_config_option') {
  const state=sessions.get(p.sessionId);const option=config(state).find(x=>x.id===p.configId);
  if(!option?.options.some(x=>x.value===p.value)) {send({id:req.id,error:{code:-32602,message:'Unsupported native choice'}});return;}
  state[p.configId==='thought_level'?'effort':p.configId]=p.value;fs.writeFileSync(path.join(home,p.sessionId+'.json'),JSON.stringify(state));result={configOptions:config(state)};
 } else if(req.method==='session/prompt') {
  if(p.prompt[0].text==='wait') {pending.set(p.sessionId,req.id);send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'waiting'}}}});return;}
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'native '+sessions.get(p.sessionId).model}}}});result={stopReason:'end_turn'};
 } else if(req.method==='session/cancel') {const id=pending.get(p.sessionId);if(id)send({id,result:{stopReason:'cancelled'}});pending.delete(p.sessionId);}
 else if(req.method==='session/close') sessions.delete(p.sessionId);
 if(req.id!==undefined)send({id:req.id,result});
});
`, { mode: 0o755 });
    const prepare = (agentId: string, home: string, sessionId?: string) => runtime.prepareAgent({
      agentId, provider: 'agy', executable, providerHomePath: home, cwd: root,
      configDir: path.join(root, 'config'), approvalMode: 'full', farmingSystemPrompt: 'native bootstrap',
      ...(sessionId ? { sessionId, historyMode: 'load' } : {}),
    });
    const homes = ['one', 'two'].map(name => path.join(root, name));
    for (const [i, home] of homes.entries()) {
      fs.mkdirSync(home);fs.writeFileSync(path.join(home, 'catalog.json'), JSON.stringify([`new-provider-model-${i}`, `another-model-${i}`]));
    }
    const sessions = await Promise.all(homes.map((home,i)=>prepare(`agy-${i}`,home)));
    const value = (agent: string, id: string) => {
      const options = runtime.getSession(agent)?.configOptions;
      assert(Array.isArray(options));
      return (options as Array<{ id: string; currentValue: unknown }>).find(option => option.id === id)?.currentValue;
    };
    assert.equal(value('agy-0','model'),'new-provider-model-0');
    assert.equal(value('agy-1','model'),'new-provider-model-1');
    assert.equal(value('agy-0','mode'),'auto');
    assert.equal(runtime.canSteer('agy-0'),false,'unsupported native capabilities are not synthesized');
    await runtime.setSessionConfigOption('agy-0','model','another-model-0');
    assert.equal(value('agy-1','model'),'new-provider-model-1');
    await assert.rejects(runtime.setSessionConfigOption('agy-0','model','not-advertised'));
    await runtime.prompt('agy-0',[{type:'text',text:'hello'}]);
    const pending=runtime.prompt('agy-0',[{type:'text',text:'wait'}]);
    await new Promise<void>((resolve,reject)=>{
      const deadline=Date.now()+3000;
      const check=()=>{
        if(JSON.stringify(runtime.getSession('agy-0')).includes('waiting'))resolve();
        else if(Date.now()>deadline)reject(new Error('native prompt did not start'));
        else setTimeout(check,10);
      };check();
    });
    await runtime.cancel('agy-0');await pending;
    await runtime.unregisterAgentAndWait('agy-0');
    await prepare('agy-0',homes[0],sessions[0].sessionId);
    assert.equal(value('agy-0','model'),'another-model-0');
    console.log('Native Antigravity ACP lifecycle and dynamic catalog tests passed');
  } finally { await runtime.dispose(); fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
