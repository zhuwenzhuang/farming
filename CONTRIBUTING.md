# Contributing

> Chinese version: [CONTRIBUTING.zh_cn.md](./CONTRIBUTING.zh_cn.md)

Thanks for helping improve Farming.

## Development Setup

```bash
npm install
npm start
```

For trusted local development only:

```bash
npm run start:no-auth
```

## Before Opening A Pull Request

Run the checks that match the change:

```bash
npm test
npm run typecheck
npm run lint
```

For browser-facing changes, also run:

```bash
npm run test:e2e:playwright
```

Please also exercise the changed flow in the real product UI. For visible or interaction changes, include a screenshot or short video in the pull request whenever practical.

For product screenshot or documentation changes:

```bash
npm run docs:product:screenshots
```

## Documentation

Update docs in the same change when behavior, packaging, configuration, or visible product flows change.

- Root project overview: `README.md` and `README.zh_cn.md`
- Agent development guide: `AGENTS.md` and `AGENTS.zh_cn.md`
- Farming Code product docs: `docs/products/code/README.md` and `docs/products/code/README.zh_cn.md`

Do not add public chat transcripts or temporary debugging notes to the repository.

## Release Hygiene

Do not commit release binaries, private hosts, personal machine paths, tokens, real `.env` files, or screenshots that expose private data.

Product screenshots should use example hostnames, anonymous paths, or the Farming repository itself when the visible content is suitable for public documentation.
