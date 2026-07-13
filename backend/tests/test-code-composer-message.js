const assert = require('assert');
const {
  appendDraftBlock,
  clipboardImageFiles,
  composerAttachmentMessageBlocks,
  composerMessageForAcp,
  composerMessageWithAttachments,
  composerPromptAttachments,
  fileDisplayName,
  formatAttachedFile,
  formatAttachedImage,
  formatAttachmentError,
  formatComposerMessage,
  isImageFile,
} = require('../../src/components/code/composer-message.ts');

function makeFile(overrides = {}) {
  return {
    name: 'notes.txt',
    type: 'text/plain',
    ...overrides,
  };
}

function run() {
  assert.strictEqual(
    appendDraftBlock('hello', 'world\n'),
    'hello\n\nworld',
    'draft blocks should be separated by one blank line'
  );
  const readyImage = {
    kind: 'image',
    status: 'ready',
    path: '/tmp/a.png',
    name: 'a.png',
    type: 'image/png',
    size: 12,
    messageBlock: 'Attached image: a.png\n\nImage path: /tmp/a.png',
  };
  assert.strictEqual(composerMessageForAcp('Please inspect', [readyImage]), 'Please inspect');
  assert.deepStrictEqual(composerPromptAttachments([readyImage]), [{
    kind: 'image',
    path: '/tmp/a.png',
    name: 'a.png',
    type: 'image/png',
    size: 12,
  }]);
  assert.strictEqual(
    composerMessageForAcp('', [{ ...readyImage, status: 'error', path: undefined, messageBlock: 'upload failed' }]),
    'upload failed'
  );
  assert.strictEqual(appendDraftBlock('hello', '   '), 'hello');

  assert.strictEqual(fileDisplayName(makeFile({ name: '' }), 'fallback.txt'), 'fallback.txt');
  assert.strictEqual(isImageFile(makeFile({ type: 'image/png' })), true);
  assert.strictEqual(isImageFile(makeFile({ type: 'application/pdf' })), false);

  const longContent = 'x'.repeat(50_005);
  const attached = formatAttachedFile(makeFile({ name: 'long.txt' }), longContent);
  assert(attached.startsWith('Attached file: long.txt\n\n'));
  assert(attached.includes('[File truncated after 50000 characters]'));

  assert.strictEqual(
    formatAttachedImage({ name: 'shot.png', path: '/tmp/shot.png', type: 'image/png', size: 12 }),
    'Attached image: shot.png\n\nImage path: /tmp/shot.png'
  );

  assert.strictEqual(
    formatAttachmentError(makeFile({ name: 'broken.png', type: 'image/png' })),
    'Attached image: broken.png\n\n[Unable to upload this image]'
  );
  assert.strictEqual(
    formatAttachmentError(makeFile({ name: 'broken.txt', type: 'text/plain' })),
    'Attached file: broken.txt\n\n[Unable to read this file as text]'
  );

  const attachments = [
    { messageBlock: 'Attached image: a.png\n\nImage path: /tmp/a.png' },
    { messageBlock: '' },
    {},
    { messageBlock: 'Attached image: b.png\n\nImage path: /tmp/b.png' },
  ];
  assert.deepStrictEqual(composerAttachmentMessageBlocks(attachments), [
    'Attached image: a.png\n\nImage path: /tmp/a.png',
    'Attached image: b.png\n\nImage path: /tmp/b.png',
  ]);
  assert.strictEqual(
    composerMessageWithAttachments('Please inspect', attachments),
    'Please inspect\n\nAttached image: a.png\n\nImage path: /tmp/a.png\n\nAttached image: b.png\n\nImage path: /tmp/b.png'
  );

  assert.strictEqual(formatComposerMessage('default', 'do it'), 'do it');
  assert(
    formatComposerMessage('plan', 'change files').startsWith('Plan mode: Inspect the relevant context first'),
    'plan mode should prefix the user message with terminal-friendly instructions'
  );
  assert(
    formatComposerMessage('goal', 'finish').startsWith('Goal mode: Treat the following as the working goal'),
    'goal mode should prefix the user message with terminal-friendly instructions'
  );

  const pngFile = makeFile({ name: 'paste.png', type: 'image/png' });
  const txtFile = makeFile({ name: 'paste.txt', type: 'text/plain' });
  assert.deepStrictEqual(
    clipboardImageFiles({ files: [txtFile, pngFile], items: [] }),
    [pngFile],
    'clipboard file list should prefer image files'
  );
  assert.deepStrictEqual(
    clipboardImageFiles({
      files: [],
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => txtFile },
        { kind: 'file', type: 'image/png', getAsFile: () => pngFile },
      ],
    }),
    [pngFile],
    'clipboard items should fall back to image file items when files is empty'
  );
  assert.deepStrictEqual(clipboardImageFiles(null), []);

  console.log('test-code-composer-message passed');
}

run();
