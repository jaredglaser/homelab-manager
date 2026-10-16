# Changelog

## [0.2.4](https://github.com/jaredglaser/homelab-manager/compare/v0.2.3...v0.2.4) (2026-10-16)


### Performance Improvements

* **ui:** shared rAF ticker for sparklines with a CSS pulse dot ([#553](https://github.com/jaredglaser/homelab-manager/issues/553)) ([1608eb3](https://github.com/jaredglaser/homelab-manager/commit/1608eb3646c3246210558b54a2412b127509a060))

## [0.2.3](https://github.com/jaredglaser/homelab-manager/compare/v0.2.2...v0.2.3) (2026-10-15)


### Features

* **docker:** unify container service identity on the label-derived service key ([#551](https://github.com/jaredglaser/homelab-manager/issues/551)) ([bf09e34](https://github.com/jaredglaser/homelab-manager/commit/bf09e348f122236e3c94ebce2d38fa7e0ec76cae))


### Bug Fixes

* **ci:** retry transient GitHub API errors in CI scripts ([#545](https://github.com/jaredglaser/homelab-manager/issues/545)) ([88b4281](https://github.com/jaredglaser/homelab-manager/commit/88b4281f8309595e94c8357de9d18dd22abd68d6))
* **docker:** register container identity from inventory events and backfill orphaned service keys ([#541](https://github.com/jaredglaser/homelab-manager/issues/541)) ([d98f93c](https://github.com/jaredglaser/homelab-manager/commit/d98f93c059d701bf1c307f6360c4ae552b704db8))
* **docker:** stop shell select trigger from overlapping modal header tabs ([#542](https://github.com/jaredglaser/homelab-manager/issues/542)) ([d2b64b0](https://github.com/jaredglaser/homelab-manager/commit/d2b64b0a0118388e21dba604038f1edce81d3bea))

## [0.2.2](https://github.com/jaredglaser/homelab-manager/compare/v0.2.1...v0.2.2) (2026-10-14)


### Features

* **agents:** manual-only agent updates triggered from the manager ([#494](https://github.com/jaredglaser/homelab-manager/issues/494)) ([20323d9](https://github.com/jaredglaser/homelab-manager/commit/20323d93822297692e7b55fa5e1497ba49bf8986))
* **agents:** overview UI with per-agent update and stale sidecar detection ([#495](https://github.com/jaredglaser/homelab-manager/issues/495)) ([510c02e](https://github.com/jaredglaser/homelab-manager/commit/510c02e58f8d8e3cfea30c68ad665001112eb61a))
* **hosts:** agents inventory API with live status and version per agent ([#492](https://github.com/jaredglaser/homelab-manager/issues/492)) ([a7afc9d](https://github.com/jaredglaser/homelab-manager/commit/a7afc9d02ea5c03c0889a2fe498a1f7bd3173c6b))
* **mock:** serve stats topics over the mock mux with drop bursts, drop their SSE branches ([#524](https://github.com/jaredglaser/homelab-manager/issues/524)) ([f2f9284](https://github.com/jaredglaser/homelab-manager/commit/f2f92842e496f3aa83415fba4a63f3432cafab15))
* **mux:** add bulk-class drop policy with dropped frame emission ([#522](https://github.com/jaredglaser/homelab-manager/issues/522)) ([5528c6a](https://github.com/jaredglaser/homelab-manager/commit/5528c6a3462851fcde8e4e662dfdd3c7aa289165))
* **mux:** add dropped frame kind and stats topic adapters ([#520](https://github.com/jaredglaser/homelab-manager/issues/520)) ([520cd70](https://github.com/jaredglaser/homelab-manager/commit/520cd70187677155408979a414f51d0fabff5959))
* **mux:** move settings and stack-status onto the mux as control topics ([#527](https://github.com/jaredglaser/homelab-manager/issues/527)) ([a87e88d](https://github.com/jaredglaser/homelab-manager/commit/a87e88d66a8ff0a5f00c6984ebc05b7e57649204))
* **mux:** one WebSocket for all live streams with Query-backed subscriptions ([#510](https://github.com/jaredglaser/homelab-manager/issues/510)) ([57719f8](https://github.com/jaredglaser/homelab-manager/commit/57719f8d50370910c17e9f784bfe4d8401016da1))
* **mux:** replace the 20-topic hard cap with a 250-topic session circuit breaker ([#516](https://github.com/jaredglaser/homelab-manager/issues/516)) ([ca6206c](https://github.com/jaredglaser/homelab-manager/commit/ca6206c68765fabe6c774084c4b74886be337574))
* **mux:** rewire useTimeSeriesStream onto the WS mux ([#523](https://github.com/jaredglaser/homelab-manager/issues/523)) ([a97a78c](https://github.com/jaredglaser/homelab-manager/commit/a97a78cf386218c74cee4ab732693c357bf710a6))
* **mux:** stats-migration layer integration and verification ([#525](https://github.com/jaredglaser/homelab-manager/issues/525)) ([b65941e](https://github.com/jaredglaser/homelab-manager/commit/b65941ed5833567df64737fde91e9db4da3a6f1e))
* **mux:** surface subscribe rejections in the UI ([#519](https://github.com/jaredglaser/homelab-manager/issues/519)) ([cef4d28](https://github.com/jaredglaser/homelab-manager/commit/cef4d28bb0e2d6122896c0f8422a261a043dd5f4))
* **mux:** warn once when many log viewers are open ([#518](https://github.com/jaredglaser/homelab-manager/issues/518)) ([a9c5400](https://github.com/jaredglaser/homelab-manager/commit/a9c5400b511aca01e3d672c13486fc0eb3677e3f))


### Bug Fixes

* **agents:** digest-pinned update targets, sidecar self-recreate, health window from image config ([#496](https://github.com/jaredglaser/homelab-manager/issues/496)) ([59af4ce](https://github.com/jaredglaser/homelab-manager/commit/59af4ce7ff2afec0e4b53646c4860fdc25b75181))
* **mux:** buffer early messages until the session registers ([#539](https://github.com/jaredglaser/homelab-manager/issues/539)) ([e79960a](https://github.com/jaredglaser/homelab-manager/commit/e79960a9c06ceab4778e8d25a71a1f39d78943c1))
* **timeseries:** merge overlapping series batches instead of appending ([#526](https://github.com/jaredglaser/homelab-manager/issues/526)) ([46b4cae](https://github.com/jaredglaser/homelab-manager/commit/46b4caefa66cca955e74cacdd0f4d3995d5c0c10))

## [0.2.1](https://github.com/jaredglaser/homelab-manager/compare/v0.2.0...v0.2.1) (2026-10-10)


### Bug Fixes

* **ci:** version-impact comment follows release-please's actual release rules ([#514](https://github.com/jaredglaser/homelab-manager/issues/514)) ([6313218](https://github.com/jaredglaser/homelab-manager/commit/6313218482fd3f31597b683520ff2930dba11f70))
