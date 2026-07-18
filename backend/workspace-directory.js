const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREATE_FORBIDDEN_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const INVALID_PATH_CODES = new Set(['EINVAL', 'ENAMETOOLONG']);

function resolveWorkspaceDirectory(value, homeDir = process.env.HOME || os.homedir()) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  const expanded = input === '~'
    ? homeDir
    : input.startsWith('~/')
      ? path.join(homeDir, input.slice(2))
      : input;
  return path.resolve(expanded);
}

function workspaceDirectoryError(error, workspace) {
  const code = error?.code || '';
  if (CREATE_FORBIDDEN_CODES.has(code)) {
    return {
      status: 403,
      body: {
        status: 'rejected',
        code: 'workspace-create-forbidden',
        workspace,
        message: `Farming does not have permission to create this directory: ${workspace}`,
      },
    };
  }
  if (code === 'ENOTDIR') {
    return {
      status: 409,
      body: {
        status: 'rejected',
        code: 'workspace-parent-not-directory',
        workspace,
        message: `A parent path is not a directory: ${workspace}`,
      },
    };
  }
  if (code === 'EEXIST') {
    return {
      status: 409,
      body: {
        status: 'rejected',
        code: 'workspace-not-directory',
        workspace,
        message: `Workspace path is not a directory: ${workspace}`,
      },
    };
  }
  if (INVALID_PATH_CODES.has(code)) {
    return {
      status: 400,
      body: {
        status: 'rejected',
        code: 'workspace-invalid-path',
        workspace,
        message: 'Workspace path is invalid',
      },
    };
  }
  return {
    status: 500,
    body: {
      status: 'rejected',
      code: 'workspace-create-failed',
      workspace,
      message: `Failed to create workspace directory: ${workspace}`,
    },
  };
}

async function prepareWorkspaceDirectory(value, options = {}) {
  const workspace = resolveWorkspaceDirectory(value, options.homeDir);
  if (!workspace) {
    return {
      status: 400,
      body: {
        status: 'rejected',
        code: 'workspace-path-required',
        workspace: '',
        message: 'Workspace path is required',
      },
    };
  }

  const fileSystem = options.fileSystem || fs.promises;
  try {
    const stat = await fileSystem.stat(workspace);
    if (!stat.isDirectory()) {
      return {
        status: 409,
        body: {
          status: 'rejected',
          code: 'workspace-not-directory',
          workspace,
          message: `Workspace path is not a directory: ${workspace}`,
        },
      };
    }
    return { status: 200, body: { status: 'ready', workspace } };
  } catch (error) {
    if (error?.code !== 'ENOENT') return workspaceDirectoryError(error, workspace);
  }

  if (options.create !== true) {
    return {
      status: 409,
      body: {
        status: 'missing',
        code: 'workspace-not-found',
        workspace,
        message: `Workspace directory does not exist: ${workspace}`,
      },
    };
  }

  try {
    await fileSystem.mkdir(workspace, { recursive: true });
    const stat = await fileSystem.stat(workspace);
    if (!stat.isDirectory()) {
      return workspaceDirectoryError({ code: 'EEXIST' }, workspace);
    }
    return { status: 201, body: { status: 'created', workspace } };
  } catch (error) {
    return workspaceDirectoryError(error, workspace);
  }
}

function createWorkspaceDirectoryRouter(options = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));
  router.post('/prepare', async (req, res) => {
    const result = await prepareWorkspaceDirectory(req.body?.workspace, {
      create: req.body?.create === true,
      fileSystem: options.fileSystem,
      homeDir: options.homeDir,
    });
    res.status(result.status).json(result.body);
  });
  return router;
}

module.exports = {
  createWorkspaceDirectoryRouter,
  prepareWorkspaceDirectory,
  resolveWorkspaceDirectory,
};
