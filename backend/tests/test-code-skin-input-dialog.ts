const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const appSource = read('src/App.tsx');
  const inputDialogSource = read('src/components/InputDialog.tsx');
  const stylesSource = read('src/styles/main.css');

  assert(
    appSource.includes('showWorkflowTaskFields={false}') &&
      inputDialogSource.includes('showWorkflowTaskFields = true') &&
      inputDialogSource.includes('!mustStartMain && showWorkflowTaskFields') &&
      inputDialogSource.includes('? mergeTaskWithWorkflow(taskText, workflowId)') &&
      inputDialogSource.includes(": { task: '', workflowTemplate: '' }"),
    'Code skin should hide Workflow and Task fields while keeping the shared dialog capable of showing them elsewhere'
  );

  assert(
    appSource.includes('const MIN_MOBILE_VISUAL_HEIGHT = 240') &&
      appSource.includes('Math.max(rawHeight, MIN_MOBILE_VISUAL_HEIGHT)') &&
      stylesSource.includes('position: fixed;\n    top: var(--app-visual-offset-top, 0);') &&
      stylesSource.includes('left: var(--app-visual-offset-left, 0);') &&
      stylesSource.includes('height: var(--app-visual-height, 100dvh);'),
    'Mobile input focus should not let iOS visualViewport glitches collapse or scroll the app shell away'
  );

  console.log('✓ Code skin hides Workflow and Task fields in New Agent dialog');
}

run();
