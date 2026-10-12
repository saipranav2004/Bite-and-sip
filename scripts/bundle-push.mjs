// Builds the push Edge Function as one file, for deploying through the Supabase
// Management API (its upload endpoint rejects multi-file functions). With Docker
// installed you can instead run: npx supabase functions deploy push --no-verify-jwt
//
//   node scripts/bundle-push.mjs > /tmp/push-index.ts
import { readFileSync } from 'node:fs'

const dir = new URL('../supabase/functions/push/', import.meta.url)
const read = (f) => readFileSync(new URL(f, dir), 'utf8').replace(/^import .* from '\.\/[a-z]+\.ts'\n/gm, '')
process.stdout.write(['// Single-file build of supabase/functions/push.', read('webpush.ts'), read('messages.ts'), read('index.ts')].join('\n'))
