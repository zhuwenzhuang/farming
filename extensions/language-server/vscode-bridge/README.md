# Farming VS Code Bridge

This user-managed VS Code extension exposes the language providers already active in one VS Code workspace to a Farming backend running as the same operating-system user.

It does not install or manage language servers. Install the language extensions you normally use in VS Code, install this Bridge into the same local or Remote SSH extension host, and keep the workspace open. Farming discovers the Bridge automatically; there are no Bridge settings, commands, or listening-port fields.

Provider queries have a Bridge-local deadline. Because VS Code provider commands cannot be cancelled, a timed-out operation remains tracked and the Bridge reports itself as stalled until that exact operation settles. New queries are rejected without invoking another provider during that interval. If the operation never settles, reload the VS Code window; Farming does not replay the query or restart VS Code automatically. Other ready VS Code windows that have the same workspace open remain eligible for routing.

For development packaging:

```bash
npx @vscode/vsce package
```

Then install the generated VSIX through VS Code. See the Farming [Language Server design](https://github.com/zhuwenzhuang/farming/blob/main/docs/products/code/language-server.md) for the complete lifecycle and security boundary.
