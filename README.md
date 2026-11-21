# bundle-gate

Gate Next.js route bundle size in CI. It reads the artifacts of a build you already ran, so it does not build your app again.

> Status: early skeleton. The size-checking core exists; reading Next.js build output and the CLI are not built yet.

## Idea

Every route gets a weight limit, like baggage at an airport. `bundle-gate` weighs each route from the build output and fails the check when a route is over its limit.

## Planned usage

```sh
next build
npx bundle-gate check
```

## Development

```sh
npm ci
npm run types
npm test
npm run build
```
