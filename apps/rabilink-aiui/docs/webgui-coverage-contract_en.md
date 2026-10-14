# WebGUI endpoint scope audit

English | [简体中文](webgui-coverage-contract.md)

`Audit-WebguiCoverage.mjs`, included in `npm run check`, checks whether public Manager paths discovered in the WebGUI can use the generic API transport. New public APIs need no audit catalog entry, Relay change, or per-interface authorization. Actual business results remain subject to the target PC handler, parameters, versions, object ownership, and explicit user disabling.

The audit uses the shared `validateApiRequest` and `API_METHODS` to check GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS for every discovered path. Mutation samples carry a stable operationId. Extracted fetch methods are descriptive; a statically observed GET must not hide restrictions on dynamic writes.

`webgui-coverage-contract.mjs` retains a regression fixture index for known UI features and connection protocols. Historical `required` entries still check existing page features, and linked fixtures still require their files to exist. Old `unsupported`, `pc-only`, and `dedicated` labels do not define public Manager API permissions. All known PC paths also receive generic transport checks; explicit Relay connection helper contracts remain separate.

Balanced template scanning handles nested `${...}` expressions and quotes. Parameters and dynamic suffixes remain `:param` and `:dynamic`, with safe samples used for transport checks. A dynamic sample is neither a complete business endpoint nor proof of a successful real request. Literal fetch scanning and a checked Skill helper are covered; this is not complete TypeScript data-flow analysis. Indirect helpers still need discovery fixtures.

Internal paths, transport-private paths, and protocol-relative external URLs remain rejected for every shared method. Generic transport still validates relative paths, headers, limits, and mutation idempotency keys. Persona, workspace, Route, and catalog registration do not add another capability permission.

Run `node --test scripts/webgui-coverage.test.mjs` from the application directory. Tests cover current discoveries, unlisted future APIs, dynamic persona and scan paths, deliberate restrictions on future writes, and private-boundary negatives across every method. Static checks and fixture-file existence do not replace actual HTTP, streaming, or device acceptance. Glasses need not duplicate the entire PC management UI.
