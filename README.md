# BrewTracker Pro

Mobile-first alus fermentācijas procesa asistents. Tas pārvalda 13 tvertnes, unikālus partiju numurus, manuālus mērījumus, procesa darbības un vēsturiskas prognozes.

## Pašreizējais statuss

Aplikācija sinhronizē datus ar Supabase un saglabā bezsaistes izmaiņas IndexedDB. Tā ir instalējama kā PWA un atbalsta ikdienas Web Push darbu paziņojumus.

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

### Web Push

1. Supabase SQL Editor izpildi `supabase/migrations/202611230002_push_subscriptions.sql`.
2. Lokāli izpildi `npm run generate:vapid` un abas izveidotās atslēgas glabā droši.
3. Netlify vietnes vides mainīgajos pievieno `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` un `VAPID_SUBJECT`.
4. `SUPABASE_SECRET_KEY` ir tikai servera atslēga bez `VITE_` prefiksa. Tā nedrīkst nonākt GitHub vai pārlūkā.
5. Pēc deploy aplikācijas Iestatījumos katrā ierīcē nospied “Ieslēgt sistēmas paziņojumus”.

Netlify plānotā funkcija tiek palaista reizi stundā un sūta paziņojumus vienreiz dienā ap 07:00 pēc `Europe/Riga` laika. Pēc dzesēšanas uz 0 °C sākšanas ikdienas mērījumi vairs netiek prasīti; tiek atgādināts tikai par filtrēšanu vai pildīšanu.

## Partijas numurs

Formāts ir `YY` + gada kārtas numurs + tvertnes numurs. Piemēram, 2026. gada 65. partija tvertnē 4 ir `26654`.
