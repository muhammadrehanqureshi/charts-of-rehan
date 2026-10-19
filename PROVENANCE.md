# Provenance

This standalone Charts release was generated from the Quant of Rehan
monorepo; release-specific sanitization and data-exclusion adjustments are
recorded in the public repository's commit history. Hashes below describe the
original export snapshot and are not asserted as hashes for the sanitized
release files.

- source repository: quant-of-rehan (`src/data` is the project's own data layer)
- source commit: `b820413361c078bdc05abfc3d79bba67d0e56dc4`
- exported: 2026-10-16T10:42:40+05:00
- files: 87 in the full generated export (78 files in the public release after private captures, builds, installed dependencies, and `.env.example` were excluded)

## Why the vendored session and tape modules ship with this project

The chart service uses the parent project's authoritative session law and
tape-bar builder rather than duplicating exchange rules or inventing bars.
The standalone export vendors the Python modules required for the app to run
without the parent checkout installed. This is a deliberate release boundary;
a smaller provider interface remains a future architectural improvement.

Local recordings and archived session data are explicitly excluded. To use
offline history, keep a private local archive outside GitHub and point Charts
at it with `--archive-dir PATH`.

## File hashes

| file | sha256 |
|---|---|
| `charts/__init__.py` | `f91a60ec323b7544577ddfbbaeb31973370ea25090395970604a775eeaa3e259` |
| `charts/__main__.py` | `e0acf0685a855c8323ab1377771206b9ab3c1ab744c06c9c5e74e2cf3ddae3b7` |
| `charts/adapters/__init__.py` | `af36ba1f758d605a1fa3379fe9888d3c0b5a1208f1111f1d6ea0ac21ecf01291` |
| `charts/adapters/base.py` | `04a5ecca5ccf9760eadc42bafa9660646da0acf6374b4778e8d273a33a4e0e36` |
| `charts/adapters/portal.py` | `6997b864964fd5621ffe71554331b227cea5c1fdf4ea6a4e62b64d50137f9718` |
| `charts/adapters/replay.py` | `018576d747b6f9b9fea44665391c87382e3fa319031cf4f9b8669c1c8d7bab1b` |
| `charts/adapters/tape.py` | `d45342ec19637e0a7c16f34ba3e6dc501c2640842c0b0d51eb1bf871a6756591` |
| `charts/app.py` | `90203dd1cc7d1a7bbefb85438545c669d806eb692e1c53539b5d9f9552eae7f4` |
| `charts/contract.py` | `c70717cf6b8840654a4ef6e9e254c045f5228badf0f5b72e04db3a2b8b02e060` |
| `charts/http.py` | `ef0808fc874e65fe403ad9d48681869ed1f9e07d533770eaf8219ee596aa146a` |
| `charts/ingest.py` | `5ac3fd11386c9115a7528f0412dd88a7f3683cb53654cc93949558c0a14f6b5d` |
| `charts/ratelimit.py` | `fa0a7bfcdaee9f8f8c2d9a327c50c69adee8a675c878509e37dceb832bc924ec` |
| `charts/README.md` | `9cf5caa85acbb61a46e5e441e4582f0d00e3dc532b324d4fc6653ff32a28211b` |
| `charts/service.py` | `1f78740e9da6083377d397880258a0051db4ad9205007c2214d90d888251057a` |
| `charts/sessions.py` | `81d15f173ebe8c694dd69abe251242d615b96be9724fdebb8b2f10bae5c981ab` |
| `charts/store.py` | `173a029f08bcf96b2ecafce333dfd0b5ccc881992b59be49968a416e06aab323` |
| `examples/charts_demo.py` | `6af6d2bc6154a1e558314b5ae18a31becb1d854661f54ca020aad7b698a576e6` |
| `src/__init__.py` | `92cf335eef9d05809abf0b36d41401e606b561bd79c2901d698b7c31526b2257` |
| `src/ci/__init__.py` | `e54c1b178fa6f1ada89385eff6de12c993e7942a1d7cc43a44dababb734e9075` |
| `src/ci/local_only.py` | `af95d6b66a2ef6b5bc39afa00e57977dcdb16fc4234657d4cfefc6ae3ec9e050` |
| `src/config.py` | `f12708b96da95ca36942fc1d97c33afaf3ea1968077b3107e782e842e624d27b` |
| `src/data/capture_health.py` | `33c8834584ed3e85e7b2ad5e3f54002eec84ee1f32bb04bf42a3e817b8c27ba9` |
| `src/data/feed_capture.py` | `55a7b34b1e17e801b8ca8bf154f91914aca251f0ae31c3f77ef7f358ff95a0a1` |
| `src/data/market_snapshot.py` | `f2d85ae57a68a9431262cbafe98fed589993f33ca7b5fc1081bc8345f1c3b2bd` |
| `src/data/ohlc_poller.py` | `562d564091c1bf09d9dc246f08a89f93c99b99346b6eb15617bb4cffd305c04f` |
| `src/data/registry.py` | `6e628e8f5cc9488ad8c4339974c1f7f9b4c0f3f0176eb28f8076953dcc994ea1` |
| `src/data/sessions.py` | `55f868d2f241a1181258e10064227a0f418e2c0c3b591ff17723779d6f9c101d` |
| `src/data/tape_bars.py` | `8304ce908349480f3fbe171e839c1363ce02bb1ffab386da9b19855e85a89835` |
| `src/data/tick_volume.py` | `544162aa387d62c1b1ad264d90b095b53bd744134c265f9791286c0227b195fe` |
| `src/data/volume_split.py` | `951b8d395c8fa97263559bbaba0cad333934451c2f18d8ee603a417e1efaadfa` |
| `src/notify/schedule_runner.py` | `2e0cdf6ae169803bd41cc5ed92a7e618992fb52298942c954ba4d974fc090061` |
| `tests/test_charts_contract.py` | `66b692e7b60d5c7359a05c3902a5dbf89682f020275bc8ef49087f6ab902887c` |
| `tests/test_charts_http.py` | `470bf1d89714a31ffd75bfc21a315ee4681bf5b215fb8834b012931e8b3950f5` |
| `tests/test_charts_ratelimit.py` | `667c36927e518b5809445b71add82d9897396d0bb3271c6c92ab8abef2d46ab4` |
| `tests/test_charts_service.py` | `8d571cbe3576c5f289ae53de226ba4725282be22310ea9adb117bdbb3ebdc71f` |
| `tests/test_charts_sessions.py` | `64712a87205bc30f94a793465f159e2f2730fb14e300b59c77d902eb6878c8b7` |
| `tests/test_charts_sources.py` | `28ff3922241823cd80e53e96d1909b1d0cb1b48101820cffb24071c380d17dda` |
| `tests/test_charts_store.py` | `9d9cf58b85306f4113fabe021fd15a5241f94b084f3ba6e8fde1d7dc014a43c9` |
| `web/index.html` | `74d93a752862be47dc8da5a150538ad0b89315cfdfc83790bae0d82b1a367b8b` |
| `web/package-lock.json` | `a41adb701719eec43d4d6286b18a9e09325ac6bca0d4968cee65e29357224a2d` |
| `web/package.json` | `7f77e32ced240a0a161452d7cd91aa88ec414cf6356dd8ce3cd7b05ba7c85f74` |
| `web/README.md` | `3595f782d0466ab38be5f62fef29a0d6eb345b3664b5c4a5e77887309128f786` |
| `web/src/api/client.test.ts` | `919e751dfd21a7d006c7bf6976a6d1dbdfdb77495f609186eef05b5d2eb649bf` |
| `web/src/api/client.ts` | `21cd1424fe85c3b268c48296c65f3297883af3f342b19fbe1be500f9e71c9a72` |
| `web/src/api/types.test.ts` | `94cd6d31dc4ba937214d5feb9647fa82f136bc28e7125712b8576a2952007658` |
| `web/src/api/types.ts` | `eb9c8adb49cc8da0af8f302de153c8b57656dc148a08f787f39b0db109f5f685` |
| `web/src/App.tsx` | `12d0294095f7aaf3cc574686a2a0e3c1d5391bc043fb1c0aa404f6d499b9895c` |
| `web/src/chart/format.test.ts` | `8dd426d8005c9aafa08b1af403e843f466fad4251df697293d10198bba51f61f` |
| `web/src/chart/format.ts` | `6dfa08e2667dbf8d92c8c801b1b61b721579f18302c87c558ae262331db70ada` |
| `web/src/chart/render.ts` | `07b7a73855f3a7c0c15af70a828ffa110209758e55dc472f7d0eeeac913c247d` |
| `web/src/chart/scale.test.ts` | `78661377af6b2621658d1a71c3055f32340bffa7cde96aae522dcba942505af5` |
| `web/src/chart/scale.ts` | `e8a755ca2be95532bbd330a9983b812563d1ea861dc63b52cc65986b81a6a196` |
| `web/src/chart/series.test.ts` | `0d16da3a269399fb9f0b3021f7bda329c84ecde3525fd0eb81511c5415a712f5` |
| `web/src/chart/series.ts` | `93bc4524a7bbb3c5920c2dcc733e939e5347d56b604bed3606a0ddc94c680730` |
| `web/src/components/ChartCanvas.tsx` | `e53c6797639b958147a7d0b55336869d555d97fe7f6b1bf1e39436ac88eabe42` |
| `web/src/components/MarketHeader.tsx` | `583bd8aded2f5a8d7167a12c58f7a4717051f84ef3d4d2d397f1745db3dd7704` |
| `web/src/components/NotesPanel.tsx` | `230e9af6e3a2a89f8c3c6d0c9f29073a684208eb7081f642ac92dbeafe4d88cc` |
| `web/src/components/SymbolPicker.tsx` | `069b8fc8959ccdd876b3a84d81f0c3fd3cbef4c3288069dd63e59966c52e2fd2` |
| `web/src/hooks/useChartFeed.ts` | `f7c1a2cd0c21395f59fdf00b30ccb0d9bdfdbed54705267b1f14377316a47cf5` |
| `web/src/main.tsx` | `0b39d7576e9e8aba7665d12ed83158e7980b372efc8423e38f873dfd5438762c` |
| `web/src/styles.css` | `cb4efc256e3e8870f6fc4936ddf870fd2f5dc9fa503cbd3fd764e9ef041fc04e` |
| `web/tsconfig.json` | `4e1f6f5f6e19e110c6b1411cdf6036977b3a127f0a9d0d11d4446c77f59a01be` |
| `web/tsconfig.node.json` | `e4464eb68323929258ebafb67aa37f6492cec2c98e3ac94b5f7756504e596ad6` |
| `web/vite.config.ts` | `e85fe6821e6f64862f4fcac60c54faefd16bc12a97339ec091ae69464f49cb08` |
