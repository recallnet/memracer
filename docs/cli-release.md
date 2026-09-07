# Releasing the memracer CLI

The CLI lives in `cli/` as the package `@recall/memracer`. The server tells
people how to install it through two surfaces: the unauthenticated
`/install.sh` route and every enrollment onboarding prompt. Both read
`src/cli-install.ts`, which picks the install command from the server env
`MEMRACER_CLI_CHANNEL`:

| `MEMRACER_CLI_CHANNEL` | Install command emitted |
|---|---|
| unset or `github-release` | `gh release download cli-latest -R recallnet/memracer -p '*.tgz' -O /tmp/mzr.tgz && npm i -g /tmp/mzr.tgz` |
| `npm` | `npm install -g @recall/memracer` |

## Publish on the `github-release` channel

The `cli-latest` tag is a moving pre-release whose single asset is the packed
tarball. Cut or replace it from the repo root:

```sh
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli run build
npm --prefix cli pack                    # writes cli/recall-memracer-<version>.tgz

# first release: create the moving tag
gh release create cli-latest cli/recall-memracer-*.tgz \
  -R recallnet/memracer --prerelease \
  --title "memracer CLI (pre-release)"

# later releases: replace the asset on the same tag
gh release upload cli-latest cli/recall-memracer-*.tgz -R recallnet/memracer --clobber
```

## Publish on the `npm` channel

1. `npm --prefix cli publish --access public`
2. Set `MEMRACER_CLI_CHANNEL=npm` on the server and restart it.

`/install.sh` and the onboarding prompts then emit `npm install -g @recall/memracer`.
