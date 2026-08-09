const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const terminalPoolSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-session-pool.ts'),
    'utf8',
  );
  const controllerSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-resize-effect-controller.ts'),
    'utf8',
  );
  const resizeSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-resize.ts'),
    'utf8',
  );

  assert(
    controllerSource.includes('export class TerminalResizeEffectController') &&
      controllerSource.includes('#resizeRequestInFlight: TerminalResizeDeliveryOperation | null') &&
      controllerSource.includes('#pendingResizeRequest: TerminalResizeDimensions | null') &&
      controllerSource.includes('attachment: this.#ports.attachmentOperation()') &&
      controllerSource.includes('baselineStateRevision: this.#ports.stateRevision()') &&
      controllerSource.includes('this.#ports.isCurrentAttachmentOperation(token.attachment)') &&
      controllerSource.includes('transition.stateRevision > inFlight.baselineStateRevision') &&
      controllerSource.includes('this.beginRecovery({ forceAfterRecovery: true })') &&
      controllerSource.includes('this.#ports.requestRecovery()') &&
      !controllerSource.includes('expireTerminalResizeDelivery'),
    'the resize-effect owner must keep one exact attachment/revision-fenced mutation and recover an uncertain timeout without replaying it',
  );

  const commitIndex = terminalPoolSource.indexOf('record.attachment.commitTransition(event)');
  const applyIndex = terminalPoolSource.indexOf('record.resizeEffects.applyCommittedRemoteResize(nextCols, nextRows');
  const installCheckpointBody = terminalPoolSource.slice(
    terminalPoolSource.indexOf('function installTerminalCheckpoint('),
    terminalPoolSource.indexOf('function requestTerminalReplay('),
  );
  const attachBody = terminalPoolSource.slice(
    terminalPoolSource.indexOf('export async function attachTerminalSession('),
    terminalPoolSource.indexOf('export function retryTerminalSession('),
  );
  assert(
    terminalPoolSource.includes('resizeEffects: TerminalResizeEffectController') &&
      terminalPoolSource.includes('resizeEffects: new TerminalResizeEffectController({') &&
      terminalPoolSource.includes('if (record.resizeEffects.applyingLocalResize) return') &&
      terminalPoolSource.includes("type: 'resize-agent'") &&
      terminalPoolSource.includes('requestRecovery: () => requestTerminalResizeRecovery(record)') &&
      commitIndex >= 0 && applyIndex > commitIndex &&
      !terminalPoolSource.includes('resizeScheduler') &&
      !terminalPoolSource.includes('resizeRequestInFlight:') &&
      !terminalPoolSource.includes('pendingResizeRequest:') &&
      !terminalPoolSource.includes('function deliverTerminalResize') &&
      !terminalPoolSource.includes('function notifyTerminalResize') &&
      installCheckpointBody.indexOf('record.resizeEffects.beginRecovery()') <
        installCheckpointBody.indexOf('record.attachment.beginCheckpointOperation(generation)') &&
      attachBody.indexOf('record.resizeEffects.beginRecovery({ forceAfterRecovery: true })') <
        attachBody.indexOf('record.attachment.beginAttachment()') &&
      terminalPoolSource.indexOf('const transitionAttachment = record.attachment.currentOperation()') <
        terminalPoolSource.indexOf('const decision = record.attachment.classifyTransition(event)') &&
      terminalPoolSource.includes('attachment: transitionAttachment'),
    'SessionRecord must expose one resize-effect collaborator while AttachmentCoordinator commits protocol order first',
  );

  assert(
    resizeSource.includes('export function normalizeTerminalResizeDimensions') &&
      resizeSource.includes('export function proposeTerminalResizeDimensions') &&
      !resizeSource.includes('TerminalResizeDeliveryTracker') &&
      !resizeSource.includes('notifyTerminalResizeTracker') &&
      !resizeSource.includes('queueTerminalResizeDelivery'),
    'the geometry helper must not retain the deleted delivery state machine',
  );

  console.log('✓ terminal resize effects have one revision-fenced owner and uncertain delivery recovery');
}

run();
