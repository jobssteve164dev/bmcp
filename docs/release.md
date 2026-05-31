# Release

## Local Package

```bash
npm install
npm run verify
```

The package command creates a `.vsix` file in the project root.

## Marketplace Publish

The Visual Studio Marketplace publish path uses `@vscode/vsce`.

Required secret:

- `VSCE_PAT`: Visual Studio Marketplace Personal Access Token for the configured publisher.

Manual publish from a prepared local shell:

```bash
export VSCE_PAT=...
npm run publish:marketplace
```

## GitHub Actions Release

The workflow at `.github/workflows/release.yml` does this from GitHub:

1. installs dependencies;
2. runs checks and tests;
3. bumps the extension version;
4. commits the version bump;
5. creates and pushes a matching git tag;
6. publishes the extension to the Visual Studio Marketplace.

Run it from GitHub Actions with `workflow_dispatch`.

The repository must have a `VSCE_PAT` secret before the workflow can publish.
