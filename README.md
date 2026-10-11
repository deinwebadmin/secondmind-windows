# secondmind – Windows

Notizen und To-Do-Listen mit **Google-Drive-Synchronisation**. Alles bleibt lokal gespeichert
(IndexedDB) und funktioniert offline – sobald Verbindung da ist, wird synchronisiert
(Standard: alle 60 Sekunden).

```
secondmind/
├── app/                 Web-App (HTML/CSS/ES-Module) – identisch zur Android-Version
│   ├── js/db.js         Lokale Datenbank (IndexedDB)
│   ├── js/sync.js       Google-Drive-Anbindung, 60-Sekunden-Takt, Offline-Puffer
│   ├── js/update.js     In-App-Update-Check (alle 30 Minuten) + Installation
│   ├── js/bridge.js     Plattform-Bridge (hier: Electron-Preload "sm")
│   └── js/{ui,views,sheets,parts}.js   Oberfläche
├── electron/main.js     Local-Server + OAuth-Loopback + Token-Verschlüsselung (DPAPI)
└── electron/preload.js  Sichere Schnittstelle für die Web-App
```

## Installation

1. Aus dem Release herunterladen:
   - [`secondmind-Setup-1.0.7.exe`](https://github.com/deinwebadmin/secondmind-windows/releases/download/v1.0.7/secondmind-Setup-1.0.7.exe) → Installation mit Startmenü-/Desktop-Verknüpfung, oder
   - [`secondmind-1.0.7-portable.exe`](https://github.com/deinwebadmin/secondmind-windows/releases/download/v1.0.7/secondmind-1.0.7-portable.exe) → läuft ohne Installation.
2. App starten → oben rechts der Kreis zeigt den Sync-Status.
3. Google Drive verknüpfen (siehe unten).

> Die Builds sind nicht code-signiert: Windows SmartScreen kann beim ersten Start warnen
> („Weitere Informationen“ → „Trotzdem ausführen“).
> Ohne Google-Verbindung läuft die App vollständig lokal weiter.

## Google Drive einrichten (einmalig)

1. <https://console.cloud.google.com> → **Neues Projekt** anlegen (z. B. `secondmind`).
2. **APIs & Dienste → Bibliothek** → „Google Drive API“ suchen → **Aktivieren**.
3. **APIs & Dienste → OAuth-Bestätigungs-Bildschirm**:
   - Nutzertyp: **External**, App-Name: `secondmind`, Support-E-Mail ausfüllen.
   - Scopes: `.../auth/drive.file`, `openid`, `email`, `profile` hinzufügen.
   - Unter **Testuser** die eigene Google-Adresse eintragen.
4. **APIs & Dienste → Zugangsdaten → OAuth-Client-ID**:
   - Anwendungstyp: **Desktop-App** (wichtig! sonst schlägt der Loopback-Flow fehl).
   - Name z. B. `secondmind-windows`.
5. Die angezeigte **Client-ID** (`…apps.googleusercontent.com`) in secondmind eintragen:
   **Einstellungen → Google Drive → OAuth Client-ID**.
6. Auf **„Mit Google verknüpfen“** tippen → Browser öffnet sich → Anmeldung → fertig.

Dieselbe Client-ID kannst du auf allen Geräten (Windows + Android) nutzen.

**Wichtig:** Solange der OAuth-Client im Status **„Testing“** steht, läuft das Refresh-Token
nach 7 Tagen ab (erneut verknüpfen nötig). Für dauerhaftes Anmelden den Bildschirm auf
**„In Veröffentlichung bringen“** stellen – für den reinen Privatgebrauch völlig ausreichend.

### Warum „Desktop-App“ statt Android-Client?

Der OAuth-Flow nutzt den **Loopback-Flow** (`http://127.0.0.1:PORT`), der für installierte
Apps gedacht ist. Dadurch brauchst du weder eine SHA-1-Fingerabdruck-Registrierung noch
kompilierte APK-Signaturen in der Cloud Console – eine einzige Client-ID für beide Plattformen.

## Synverhalten

| Situation | Verhalten |
|---|---|
| Änderung lokal | Sofort in IndexedDB gespeichert, ~2,5 s später automatisch hochgeladen |
| Regelmäßiger Abgleich | Alle 60 s (in den Einstellungen 30 s / 2 Min / 5 Min wählbar) |
| Keine Internetverbindung | Alles bleibt lokal; Status-Punkt wird grau |
| Verbindung zurück | Sofortiger Abgleich (Event `online`) |
| Zwei Geräte ändern dasselbe | Last-Writer-Wins nach `updatedAt` (feine Auflösung, konfliktfrei) |
| Fotos/Dateien | Werden nach Google Drive (`Ordner/secondmind`) hochgeladen; Bilder werden erst beim Öffnen einer Notiz heruntergeladen |

Daten liegen im Google-Drive-Ordner **`secondmind`**:
`secondmind.db.json` (alle Datensätze) und Dateien namens `sm-file-…` für Anhänge.
Der Ordner gehört dir – die App greift nur auf ihn zu (Scope `drive.file`).

Zusätzlich kannst du unter **Einstellungen → Daten** jederzeit ein JSON-Backup exportieren/importieren.

## Funktionen

- **Suche** oben, **+** unten rechts, **Logo oben links** öffnet das Menü (Start, Archiv, Memory, Einstellungen).
- **Notizen**: Titel, Text, Links, Fotos/Dokumente, Hintergrundfarbe, Tags, Anpinnen,
  Verknüpfung mit beliebigen To-Do-Punkten.
- **To-Do-Vorlagen**
  - **Woche**: 7 Wochentage, Punkte pro Tag zuweisen und verschieben, Historie, Archiv, Memory.
  - **Standard**: Titel + Punkte mit Unterpunkten, alle Funktionen.
  - **Simpel**: nur Liste – abgehakte Punkte werden direkt entfernt (mit „Rückgängig“), kein Archiv.
- **Unterpunkte** mit Fortschrittslinie am Hauptpunkt; Unterpunkte bleiben nach dem Abhaken
  sichtbar (grau + Linie aktualisiert sich).
- **Abgehakte Hauptpunkte** rutschen ans Listenende in „Abgehakt & Historie“.
- **Wischen**: Links = Archiv (bzw. Memory bei Punkten), Rechts = Löschen mit Rückfrage/Rückgängig.
- **Archiv**: ganze Listen/Notizen bleiben intakt und werden nur verschoben; einzelne Punkte
  landen in „*Name der Liste* – Archiv“. Sortierung nach Jahr.
- **Memory**: eine Liste pro Jahr für dorthin verschobene Punkte.
- **Farbcodierung** grün/gelb/rot/neutral für Punkte und Unterpunkte (Dringlichkeit).
- **Einstellungen**: Memory an/aus, „Vor dem Löschen fragen“, Historie anzeigen, Design
  (Hell/Dunkel/Auto), Sync-Intervall, Export/Import.

## Entwicklung

```powershell
npm install
npm start          # App im Entwicklungsmodus starten
npm run dist       # Setup + Portable-EXE nach dist/
```

Voraussetzungen: Node.js ≥ 20. Der Build verwendet `electron-builder` (Windows-Ziele: NSIS-Setup + Portable).

## Sicherheit

- OAuth-Tokens werden mit **Windows Data Protection API** (safeStorage) verschlüsselt
  im lokalen Profil abgelegt – nicht im Klartext.
- Standard-Scope ist `drive.file` („nur Dateien, die diese App angelegt hat“).
  In den Einstellungen kann auf vollen Drive-Zugriff gewechselt werden, falls die Geräte
  sich gegenseitig die Dateien nicht sehen.
- Kein Server, kein Account – nur du und dein Google-Konto.

## Lizenz

MIT

## Siehe auch

- [secondmind-android](https://github.com/deinwebadmin/secondmind-android) – dieselbe App für Android (gleiche Google-Client-ID, gleicher Drive-Ordner)

## Änderungen

### 1.0.7
- **In-App-Updates**: secondmind prüft alle 30 Minuten (und manuell in den Einstellungen) nach neuen Versionen und fragt „Jetzt aktualisieren oder Später?“. Beim Bestätigen wird das Update direkt geladen und installiert – Einträge, Einstellungen und die Drive-Verknüpfung bleiben vollständig erhalten
- **Einstellungen synchronisieren**: Theme, Kalender-/Memory-Schalter, OAuth-Client-ID usw. liegen jetzt als eigener Datensatz in der Drive-Datei. Ein zweites Gerät übernimmt nach dem Verbinden automatisch alle Einstellungen des ersten Geräts (Tags und Tag-Farben lieferten ohnehin schon die Listen-/Notiz-Datensätze)

### 1.0.6
- **Archiv-Button an jedem Punkt**: Direkt in der Punktzeile (neben Farbe, Kalender und Büroklammer) – verschiebt den Punkt mit einem Tipp ins Memory (bzw. ins Archiv bei Simpel-Listen), inklusive Rückgängig-Toast
- **Unterpunkte wandern mit**: Wird ein Hauptpunkt ins Memory/Archiv verschoben, gehen alle seine Unterpunkte mit – nichts verschwindet mehr
- **Memory zeigt Gruppen vollständig**: Hauptpunkte erscheinen mit allen eingerückten Unterpunkten, inklusive Notiz-Rückverweis, Termin und Quelle/Datum; Wiederherstellen (↺) holt immer die ganze Gruppe zurück
- Dasselbe Gruppen-Layout im Archiv für Simpel-Listen

### 1.0.5
- **Intensivere Hintergrundfarben**: Die 15 Hintergrundtöne sind jetzt kräftig gesättigt (Gelb, Orange, Rot, Pink, Violett, Blau, Türkis, Grün, Braun, Grau) – die Kontraste sind klar erkennbar
- **Automatische Schriftfarbe überall**: Helle Töne bekommen dunkle Schrift, kräftige/dunkle Töne weiße Schrift – auch im Titel der Listen-Detailansicht (war vorher immer schwarz)

### 1.0.4
- **Kalender als echtes Wochenraster**: 24-Stunden-Zeitachse links, 7 Tagesspalten nebeneinander – Termine stehen positionsgenau auf ihrem Wochentag und ihrer Uhrzeit; die Ansicht springt direkt zur aktuellen Zeit
- **Termine per Drag & Drop verschieben**: Eintrag anfassen und auf einen anderen Tag ziehen (Ziel-Spalte leuchtet auf) oder höher/tiefer schieben – die Uhrzeit rastet im 15-Minuten-Raster ein; Tippen öffnet weiterhin das Termin-Sheet
- **Reihenfolge in To-Do-Listen ändern**: Hauptpunkte und Unterpunkte lassen sich nach kurzem Drücken verschieben – die Zeile hebt ab, die Nachbarn machen Platz; in Wochenlisten landet ein gezogener Punkt automatisch auf dem Ziel-Tag
- Überlagernde Termine teilen sich die Tagesspalte nebeneinander statt sich zu verdecken

### 1.0.3
- **Kalender** (optional, in den Einstellungen zuschaltbar): Termine mit Datum, Uhrzeit und Dauer direkt am Punkt planen – Kalender-Button in jeder Punktzeile, neue Wochenansicht (‹ ›, „Heute", Wischgeste) über dem Menü-Button in der Topbar, Einträge antippen zum Verschieben, „＋ To-Do einplanen" aus dem Kalender heraus
- **Tags bekommen eigene Farben**: Tag-Sheet mit Farbpalette (7 Farben), farbige Chips auf Karten und in den Detailansichten; Tag-Button (🏷) oben rechts auf jeder Startseiten-Karte
- **Mehr Hintergrundfarben**: das Farben-Sheet bietet jetzt 15 Töne statt 5
- **Drei-Punkte-Menü in den Detailansichten entfernt**: Listen und Notizen haben jetzt sechs einzelne Icon-Buttons (Anpinnen, Titel, Farbe, Tags, Archiv, Löschen – bei Notizen plus Verknüpfen)
- **Bugfix**: die Archiv-Seite rendert nach dem Wiederherstellen des letzten Eintrags wieder korrekt (Leerzustand statt veralteter Ansicht)

### 1.0.2
- **Anpinnen direkt auf der Startseite** – Pin-Button auf jeder Karte (Liste & Notiz)
- **Startseite zeigt Vorschauen**: die ersten 5 Hauptpunkte einer Liste, die ersten 5 Zeilen einer Notiz
- **Farbcodierung färbt den ganzen Punkt bzw. Unterpunkt** ein (statt nur eines Punktes am Rand)
- **Farb- und Büroklammer-Buttons direkt in der Punktzeile** – Notiz verknüpfen geht jetzt ohne Umweg über das Menü
- **Unterpunkte sind einzeln bedienbar**: eigene Wischgesten (Links = Löschen, Rechts = Memory) plus eigene Zeilen-Buttons
- **Leere Buttons unten entfernt**: Das Logo führt direkt auf die Startseite, daneben öffnet ein Menü-Button ( drei Striche ) den Drawer; die „＋ Neu“-Buttons an den Abschnittsüberschriften entfallen
- **Memory funktioniert wirklich**: nach Memory/Archiv verschobene Punkte verschwinden aus der Liste und tauchen in der jeweiligen Ansicht auf

### 1.0.1
- „＋ Unterpunkt“ ist jetzt in **allen Vorlagen** (Woche, Standard, Simpel) direkt am Hauptpunkt sichtbar
- Notiz ↔ To-Do-Verknüpfungen zeigen **beidseitig** aufeinander: Chip am Punkt, Liste in der Notiz, Lösen per ×
- Konto-Wechsel abgesichert: bei einem anderen Google-Konto werden alte Drive-IDs verworfen und fehlende Dateien automatisch neu angelegt
- Export/Import enthält jetzt auch die Einstellungen (praktisch für ein zweites Gerät)

### 1.0.0
- Erstveröffentlichung
