const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREATE_FORBIDDEN_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const INVALID_PATH_CODES = new Set(['EINVAL', 'ENAMETOOLONG']);
const DEFAULT_BROWSE_LIMIT = 500;

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

async function browseWorkspaceDirectory(value, options = {}) {
  const workspace = resolveWorkspaceDirectory(value || '~', options.homeDir);
  const fileSystem = options.fileSystem || fs.promises;
  let entries;
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
    entries = await fileSystem.readdir(workspace, { withFileTypes: true });
  } catch (error) {
    const forbidden = CREATE_FORBIDDEN_CODES.has(error?.code);
    const missing = error?.code === 'ENOENT';
    return {
      status: forbidden ? 403 : missing ? 404 : 500,
      body: {
        status: 'rejected',
        code: forbidden
          ? 'workspace-browse-forbidden'
          : missing
            ? 'workspace-not-found'
            : 'workspace-browse-failed',
        workspace,
        message: forbidden
          ? `Farming does not have permission to read this directory: ${workspace}`
          : missing
            ? `Workspace directory does not exist: ${workspace}`
            : `Failed to read workspace directory: ${workspace}`,
      },
    };
  }

  const directories = (await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
    const childPath = path.join(workspace, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fileSystem.stat(childPath);
        if (!stat.isDirectory()) return null;
      } catch {
        return null;
      }
    }
    return { name: entry.name, path: childPath };
  })))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_BROWSE_LIMIT, DEFAULT_BROWSE_LIMIT));
  const parentPath = path.dirname(workspace);

  return {
    status: 200,
    body: {
      status: 'ready',
      workspace,
      parent: parentPath === workspace ? null : parentPath,
      directories: directories.slice(0, limit),
      truncated: directories.length > limit,
    },
  };
}

function createWorkspaceDirectoryRouter(options = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));
  router.get('/browse', async (req, res) => {
    const result = await browseWorkspaceDirectory(req.query?.path, {
      fileSystem: options.fileSystem,
      homeDir: options.homeDir,
      limit: req.query?.limit,
    });
    res.status(result.status).json(result.body);
  });
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
  browseWorkspaceDirectory,
  createWorkspaceDirectoryRouter,
  prepareWorkspaceDirectory,
  resolveWorkspaceDirectory,
};
