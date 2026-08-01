# Farming VS Code Bridge

This user-managed VS Code extension exposes the language providers already active in one VS Code workspace to a Farming backend running as the same operating-system user.

It does not install or manage language servers. Install the language extensions you normally use in VS Code, install this Bridge into the same local or Remote SSH extension host, and keep the workspace open. Farming discovers the Bridge automatically; there are no Bridge settings, commands, or listening-port fields.

For development packaging:

```bash
npx @vscode/vsce package
```

Then install the generated VSIX through VS Code. See the Farming [Language Server design](https://github.com/zhuwenzhuang/farming/blob/main/docs/products/code/language-server.md) for the complete lifecycle and security boundary.
