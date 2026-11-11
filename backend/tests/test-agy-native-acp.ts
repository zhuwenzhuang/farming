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
const sessions = new Map(), pending = new Map(), permissions = new Map();
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const modeOptions = ['default','accept-edits','auto','plan'].filter(value=>value!=='default'||!fs.existsSync(path.join(home,'omit-default'))).map(value=>({value,name:value}));
const config = state => [
 {id:'model',name:'Model',category:'model',type:'select',currentValue:state.model,options:models.map(value=>({value,name:value}))},
 {id:'thought_level',name:'Thinking Level',category:'thought_level',type:'select',currentValue:state.effort,options:[{value:'provider-effort',name:'Provider effort'}]},
 {id:'mode',name:'Mode',category:'mode',type:'select',currentValue:state.mode,options:modeOptions}];
readline.createInterface({input:process.stdin}).on('line', line=>{
 const req=JSON.parse(line), p=req.params||{};let result={};
 if (!req.method && permissions.has(req.id)) {
  const {promptId,sessionId}=permissions.get(req.id); permissions.delete(req.id);
  fs.writeFileSync(path.join(home,sessionId+'.permission'),JSON.stringify(req.result));
  send({id:promptId,result:{stopReason:'end_turn'}}); return;
 }
 if(req.method==='initialize') result={protocolVersion:1,agentInfo:{name:'Antigravity ACP Server',version:'1.5.5'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}};
 else if(['session/new','session/load','session/resume'].includes(req.method)) {
  const id=p.sessionId||require('crypto').randomUUID();
  const state=p.sessionId?JSON.parse(fs.readFileSync(path.join(home,id+'.json'))):{model:models[0],effort:'provider-effort',mode:'default'};
  if(p._meta?.antigravity?.systemPrompt?.append!=='native bootstrap') throw Error('missing native system metadata');
  sessions.set(id,state);fs.writeFileSync(path.join(home,id+'.json'),JSON.stringify(state));
  result={sessionId:id,configOptions:config(state),modes:{currentModeId:state.mode,availableModes:modeOptions.map(x=>({id:x.value,name:x.name}))}};
 } else if(req.method==='session/set_config_option') {
  fs.appendFileSync(path.join(home,'requests.jsonl'),JSON.stringify(p)+'\\n');
  const state=sessions.get(p.sessionId);const option=config(state).find(x=>x.id===p.configId);
  if(!option?.options.some(x=>x.value===p.value)) {send({id:req.id,error:{code:-32602,message:'Unsupported native choice'}});return;}
  if(fs.existsSync(path.join(home,'reject'))) {send({id:req.id,error:{code:-32602,message:'Permission mode rejected'}});return;}
  if(fs.existsSync(path.join(home,'unconfirmed'))) {send({id:req.id,result:{configOptions:config(state)}});return;}
  state[p.configId==='thought_level'?'effort':p.configId]=p.value;fs.writeFileSync(path.join(home,p.sessionId+'.json'),JSON.stringify(state));result={configOptions:config(state)};
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'config_option_update',configOptions:config(state)}}});
 } else if(req.method==='session/prompt') {
  if(p.prompt[0].text==='native-auto') {
   sessions.get(p.sessionId).mode='auto';
   send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'current_mode_update',currentModeId:'auto'}}});
   send({id:req.id,result:{stopReason:'end_turn'}});return;
  }
  if(p.prompt[0].text==='drop-mode') {
   send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'config_option_update',configOptions:config(sessions.get(p.sessionId)).filter(x=>x.id!=='mode')}}});
   send({id:req.id,result:{stopReason:'end_turn'}});return;
  }
  if(p.prompt[0].text==='permission') {
   send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'config_option_update',configOptions:config(sessions.get(p.sessionId))}}});
   const id='permission-'+req.id; permissions.set(id,{promptId:req.id,sessionId:p.sessionId});
   send({id,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{toolCallId:id,title:'Write isolated proof',kind:'execute',status:'pending'},options:[{optionId:'always',name:'Always',kind:'allow_always'},{optionId:'once',name:'Once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});return;
  }
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
    assert.equal(value('agy-0','mode'),'bypassPermissions');
    assert.equal(JSON.parse(fs.readFileSync(path.join(homes[0], sessions[0].sessionId + '.json'),'utf8')).mode, 'default');
    assert.equal(runtime.canSteer('agy-0'),false,'unsupported native capabilities are not synthesized');
    await runtime.setSessionConfigOption('agy-0','model','another-model-0');
    assert.equal(value('agy-0','mode'),'bypassPermissions', 'native config notifications retain client policy');
    assert.equal(value('agy-1','model'),'new-provider-model-1');
    await assert.rejects(runtime.setSessionConfigOption('agy-0','model','not-advertised'));
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Permission state transition timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const permissionResult = () => JSON.parse(fs.readFileSync(path.join(homes[0], sessions[0].sessionId + '.permission'), 'utf8'));
    await runtime.prompt('agy-0', [{ type: 'text', text: 'permission' }]);
    assert.equal(permissionResult().outcome.optionId, 'once', 'full access must never persist allow_always rules');
    for (const mode of ['default', 'auto', 'accept-edits', 'plan']) {
      await runtime.setSessionMode('agy-0', mode);
      const turn = runtime.prompt('agy-0', [{ type: 'text', text: 'permission' }]);
      const binding = runtime.bindings.get('agy-0')!;
      await waitFor(() => binding.pendingPermissions.size === 1);
      assert.equal(value('agy-1', 'mode'), 'bypassPermissions', 'another Home must retain its permission policy');
      const permission = [...binding.pendingPermissions.values()][0];
      runtime.respondPermission('agy-0', permission.requestId as string, 'deny');
      await turn;
      assert.equal(permissionResult().outcome.optionId, 'deny', `${mode} must leave native requests to the user`);
      await runtime.setSessionConfigOption('agy-0', 'mode', 'bypassPermissions');
      await runtime.prompt('agy-0', [{ type: 'text', text: 'permission' }]);
      assert.equal(permissionResult().outcome.optionId, 'once');
    }
    for (const failure of ['reject', 'unconfirmed']) {
      await runtime.setSessionConfigOption('agy-0', 'mode', 'auto');
      const count = () => fs.readFileSync(path.join(homes[0], 'requests.jsonl'), 'utf8').trim().split('\n').length;
      const before = count();
      fs.writeFileSync(path.join(homes[0], failure), '');
      await assert.rejects(runtime.setSessionConfigOption('agy-0', 'mode', 'bypassPermissions'), /rejected|did not confirm/);
      assert.equal(count(), before + 1, 'permission mutations must not be replayed');
      assert.equal(value('agy-0', 'mode'), 'auto', 'a failed request cannot enable full access');
      fs.unlinkSync(path.join(homes[0], failure));
    }
    await runtime.setSessionConfigOption('agy-0', 'mode', 'bypassPermissions');
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
    const deferred = await runtime.setSessionConfigOption('agy-0', 'mode', 'default');
    assert.equal('deferred' in deferred && deferred.deferred, true);
    assert.equal(value('agy-0', 'mode'), 'bypassPermissions', 'permission changes wait until the active Turn settles');
    await runtime.cancel('agy-0');await pending;
    await waitFor(() => value('agy-0', 'mode') === 'default');
    await runtime.setSessionConfigOption('agy-0', 'mode', 'bypassPermissions');
    const savedOverrides = runtime.bindings.get('agy-0')!.restartOptions.configOverrides;
    await runtime.unregisterAgentAndWait('agy-0');
    await runtime.prepareAgent({ agentId: 'agy-0', provider: 'agy', executable, providerHomePath: homes[0], cwd: root,
      configDir: path.join(root, 'config'), approvalMode: 'approve', farmingSystemPrompt: 'native bootstrap',
      sessionId: sessions[0].sessionId, historyMode: 'load', configOverrides: savedOverrides });
    assert.equal(value('agy-0','model'),'another-model-0');
    assert.equal(value('agy-0','mode'),'bypassPermissions', 'saved full access overrides the restricted launch default');
    await runtime.prompt('agy-0', [{ type: 'text', text: 'permission' }]);
    assert.equal(permissionResult().outcome.optionId, 'once');
    await runtime.prompt('agy-0', [{ type: 'text', text: 'drop-mode' }]);
    assert.equal(runtime.getSession('agy-0').currentModeId, '', 'removed capability revokes Full access');
    const controller = new AbortController();
    const lostCapabilityBinding = runtime.bindings.get('agy-0')!;
    const permissionAfterRemoval = runtime.requestPermission(lostCapabilityBinding, { sessionId: sessions[0].sessionId,
      options: [{ optionId: 'once', kind: 'allow_once' }] }, controller.signal);
    assert.equal(lostCapabilityBinding.pendingPermissions.size, 1, 'launch full is not a fallback after capability removal');
    controller.abort();await permissionAfterRemoval;
    await runtime.unregisterAgentAndWait('agy-0');
    await runtime.prepareAgent({ agentId: 'agy-0', provider: 'agy', executable, providerHomePath: homes[0], cwd: root,
      configDir: path.join(root, 'config'), approvalMode: 'approve', farmingSystemPrompt: 'native bootstrap',
      sessionId: sessions[0].sessionId, historyMode: 'load', configOverrides: savedOverrides });
    assert.equal(value('agy-0', 'mode'), 'bypassPermissions');
    await runtime.prompt('agy-0', [{ type: 'text', text: 'native-auto' }]);
    assert.equal(value('agy-0', 'mode'), 'auto', 'a native mode change revokes client full access');
    await runtime.unregisterAgentAndWait('agy-0');
    await runtime.prepareAgent({ agentId: 'agy-0', provider: 'agy', executable, providerHomePath: homes[0], cwd: root,
      configDir: path.join(root, 'config'), approvalMode: 'full', farmingSystemPrompt: 'native bootstrap',
      sessionId: sessions[0].sessionId, historyMode: 'load', configOverrides: [{ configId: 'mode', value: 'auto' }] });
    assert.equal(value('agy-0', 'mode'), 'auto', 'existing saved auto must never be migrated to full access');
    fs.writeFileSync(path.join(homes[1], 'omit-default'), '');
    await assert.rejects(prepare('unsupported', homes[1]), /did not advertise permission mode bypassPermissions/);
    console.log('Native Antigravity ACP lifecycle and dynamic catalog tests passed');
  } finally { await runtime.dispose(); fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
