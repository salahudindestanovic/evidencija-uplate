# Evidencija naplate — Škola Kur'ana

Web aplikacija za vođenje mjesečne članarine: učenici, grupe, uplate, dugovanja i izvještaji.
Radi u browseru na kompjuteru i telefonu.

## Šta radi

- **Struktura škole:** grad → odjeljenje → grupa → učenik (npr. Tutin → Raduhovci → Sufara 2)
- **Grupe** po nivoima nastave (Sufara, Tedžvid, Amme džuz, Hifz) s mjesečnom cijenom i profesorom/muhaffizom
- **Učenici** sa standardnom cijenom (25 €, s prevozom 50 €) ili drugačijim iznosom koji škola upiše, i dugom iz ranije
- **Automatska zaduženja** — svaki mjesec od upisa do ispisa, osim neplatnih mjeseci (npr. juli i august).
  Iznos, grupa i odjeljenje se zaključavaju za taj mjesec, pa promjene ne mijenjaju historiju.
- **Uplate** za jedan ili više mjeseci odjednom, djelimične uplate i plaćanje unaprijed
- **Uloge:**

  | Uloga | Vidi | Može |
  |---|---|---|
  | Glavni administrator | Sve gradove; u meniju bira grad ili odjeljenje | Sve, uključujući gradove, odjeljenja i postavke |
  | Koordinator | Svoj grad ili samo svoje odjeljenje | Učenici, grupe, uplate, storniranje, izvještaji, profesori i blagajnici; može i predavati |
  | Blagajnik | Svoj grad ili odjeljenje | Uplate, storniranje i izvještaji; ne uređuje učenike ni grupe |
  | Profesor | Samo svoje grupe | Upis i uređivanje učenika u svojim grupama i uplate (oboje se može isključiti u Postavkama); posebnu cijenu, datum upisa i brisanje ne mijenja |

- **Izvještaji** — jedan pregled za mjesec ili cijelu školsku godinu, za sve gradove, jedan grad ili jedno odjeljenje,
  koji odgovara na tri pitanja: *Koliko smo naplatili? Ko duguje? Gdje je novac?* Uz to: izvještaj za upravu spreman
  za štampu/PDF (s logom i mjestom za potpis), Excel izvoz, te detaljni spiskovi dužnika, uplata i dnevnik promjena.

## Zaštita finansijskih podataka

- **Uplata ne može biti veća od preostalog iznosa za mjesec.** Time se hvataju greške u kucanju (1000 umjesto 10,00)
  i dvostruka naplata istog mjeseca. Datum uplate ne može biti u budućnosti.
- **Dnevnik promjena** (Izvještaji → Dnevnik promjena): svako storniranje (uz obavezan razlog), izmjena zaduženja,
  promjena posebne cijene ili mjeseca upisa i brisanje učenika, s imenom osobe i vremenom.
- **Rezervna kopija baze** svaki dan u `data/backups/` (čuva se 30 dana). Preporuka: tu fasciklu kopirati i van servera.
- **Prijava:** nakon 8 pogrešnih lozinki za isto korisničko ime slijedi pauza od 15 minuta.
- Sva vremena su po lokalnom vremenu škole (`Europe/Belgrade`, može se promijeniti varijablom `TZ`).

## Na telefonu

Aplikacija je pravljena prvo za telefon: donji meni, veliko dugme **+ Uplata**, spisak učenika kao kartice
sa statusom i dugom, a nakon uplate povratak na spisak grupe.

**Instalacija kao aplikacija** (radi tek kad je aplikacija na serveru s HTTPS-om):
- *Android (Chrome):* meni ⋮ → **Instaliraj aplikaciju** / Dodaj na početni ekran
- *iPhone (Safari):* dugme Dijeli → **Dodaj na početni zaslon**

Otvara se preko cijelog ekrana, sa svojom ikonom, bez adresne trake.

## Pokretanje

Potreban je Node.js 22.13 ili noviji (koristi ugrađeni SQLite, nema dodatne baze).

```bash
npm install
npm start
```

Otvorite http://localhost:3000 — pri prvom pokretanju kreirate administratorski račun.

### Demo podaci (za prezentaciju)

```bash
npm run demo
```

Puni praznu bazu strukturom iz godišnjeg izvještaja Škole za 2025. godinu: 10 gradova/područja (s Beogradom i
Novom Varoši), 42 odjeljenja, koordinatori, blagajnici, profesori i muhaffizi po imenu, te oko 2.450 izmišljenih
učenika s uplatama i upisima u januaru i septembru. Članarina je 25 €, s prevozom (kombi u Novom Pazaru,
Tutinu i Sjenici) 50 €; popusti nisu izmišljani (sva demo djeca plaćaju standardno), a dio djece ima dug iz ranije. Lozinka za sve: `demo1234`, a na stranici
za prijavu je i "Demo pristup" — prijava jednim klikom kao uprava, koordinator, blagajnik ili profesor. Skripta na kraju ispiše korisnička imena; na primjer:

| Korisnik | Uloga |
|---|---|
| `admin` | Glavni administrator (uprava) |
| `dzemil.destanovic`, `irfan.malic` | Glavni administratori |
| `aldin.hot` | Koordinator — Tutin |
| `enver.eminovic` | Koordinator — Tutin · Raduhovci |
| `elma.fijuljanin` | Blagajnik — Sjenica |
| `haris.saracevic` | Profesor — Novi Pazar |

Prije prave upotrebe obrišite folder `data/`.

## Postavljanje na server

Aplikacija je jedan Node.js proces i jedna SQLite datoteka (`data/evidencija.db`). Radi na bilo kojem VPS-u
(Hetzner, DigitalOcean…) ili hostingu koji podržava Node.js i trajni disk.

Varijable okruženja:

| Varijabla | Opis |
|---|---|
| `PORT` | Port (zadano 3000) |
| `DATA_DIR` | Folder za bazu (zadano `./data`) |
| `COOKIE_SECURE=1` | Uključite kad aplikacija radi preko HTTPS-a |
| `SESSION_SECRET` | Opcionalno; inače se generiše i čuva u bazi |

Preporuka: pokretati iza Nginx/Caddy s HTTPS-om, kroz `pm2` ili systemd.

**Backup:** dovoljno je redovno kopirati `data/evidencija.db` (npr. svaku noć).

## Struktura

```
server.js            pokretanje i middleware
src/db.js            šema baze i postavke
src/billing.js       zaduženja, stanja, zbirovi
src/helpers.js       formatiranje iznosa, datuma i mjeseci
src/routes/          stranice (učenici, grupe, uplate, izvještaji, admin)
views/               EJS šabloni
public/              CSS i mali JS
scripts/demo.js      demo podaci
```
