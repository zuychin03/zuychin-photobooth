# Synthetic template fixture

`synthetic.pbtemplate` uses the built-in `strip4` geometry and one 640 × 480 solid-colour PNG decoration from `../projects/b.png`. It contains no people, source photos, room access or real personal details. Its two private text examples are synthetic and intentionally removed by the default exporter. The resulting caption and text layer are blank, and account scope is removed. Empty text geometry remains available to edit after import.

Regenerate from the repository root with:

```powershell
node --import tsx tests/fixtures/templates/generate.ts
```

The generator calls the real schema, project-to-template converter and bundle exporter/importer. It verifies blank private text, device scope and exact original PNG hashes. Its injected inspector checks deterministic PNG headers; it does not claim native browser decoding. Importing this file through the normal template shelf exercises the browser's native image inspector separately. Do not upload this fixture to hosted services for local smoke tests.
