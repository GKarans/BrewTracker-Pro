# BrewTracker Pro

Mobile-first alus fermentācijas procesa asistents. Tas pārvalda 13 tvertnes, unikālus partiju numurus, manuālus mērījumus, procesa darbības un vēsturiskas prognozes.

## Pašreizējais statuss

Pirmā darbināmā versija darbojas local-first režīmā ar IndexedDB. Mērījumus var ievadīt bez interneta. `supabase/migrations` satur sākotnējo PostgreSQL shēmu; kopīgā autentifikācija un sinhronizācijas transports tiks aktivizēts pēc Supabase projekta izveides.

## Palaišana

```bash
npm install
npm run dev
```

Ražošanas būve:

```bash
npm run test
npm run build
```

## Netlify

Build command: `npm run build`

Publish directory: `dist`

Vides mainīgos kopē no `.env.example`. Frontendā drīkst izmantot tikai Supabase publishable key; service role atslēgu nedrīkst ievietot pārlūka kodā.

## Partijas numurs

Formāts ir `YY` + gada kārtas numurs + tvertnes numurs. Piemēram, 2026. gada 65. partija tvertnē 4 ir `26654`.
