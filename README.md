# secondmind – Windows

Notizen und To-Do-Listen mit **Google-Drive-Synchronisation**. Alles bleibt lokal gespeichert
(IndexedDB) und funktioniert offline – sobald Verbindung da ist, wird synchronisiert
(Standard: alle 60 Sekunden).

```
secondmind/
├── app/                 Web-App (HTML/CSS/ES-Module) – identisch zur Android-Version
│   ├── js/db.js         Lokale Datenbank (IndexedDB)
│   ├── js/sync.js       Google-Drive-Anbindung, 60-Sekunden-Takt, Offline-Puffer
│   ├── js/bridge.js     Plattform-Bridge (hier: Electron-Preload "sm")
│   └── js/{ui,views,sheets,parts}.js   Oberfläche
├── electron/main.js     Local-Server + OAuth-Loopback + Token-Verschlüsselung (DPAPI)
└── electron/preload.js  Sichere Schnittstelle für die Web-App
```

## Installation

1. `dist/secondmind-Setup-1.0.0.exe` (oder die Portable-Datei) aus dem Release/`dist`-Ordner starten.
2. App starten → oben rechts der Kreis zeigt den Sync-Status.
3. Google Drive verknüpfen (siehe unten).

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
