# Umsetzungskontrolle für FigJam MCP 0.4.0

Stand: 8. Oktober 2026. Grundlage ist der [Projektreview](2026-10-08-project-audit.md).
Version 0.4.0 ist als Release-Kandidat vorbereitet; diese Datei bestätigt keine Veröffentlichung.

**Historischer Stand:** Die ergänzende [Abnahme vom 9. Oktober](2026-10-09-acceptance.md)
enthält die neueren Paketprüfungen, echten synthetischen Modellläufe und das aktuelle Archiv.

## Getrennt prüfbare Arbeitspakete

| Paket | Umgesetzt | Zentrale Prüfpunkte |
| --- | --- | --- |
| 1 — Wartung | MIT mit Copyright 2026 ecestnrkl, Paket-/Supportlinks, Node 22.12+, aktualisierte Abhängigkeiten, Beiträge/Security/Issues/Changelog, wöchentlicher Dependabot | Paketmetadaten, Lizenz im Tarball, npm-Sicherheitsabgleich |
| 2 — Quellen | Vollständige Originaltexte und Tabellenzellen, Seite/innerste Section, stabile Mitgliedsidentität, interne und externe gerichtete Verbindungen, iterative Extraktion | Sechster Sticky, späte Textstellen, Tabellenänderungen, gleiche Koordinaten auf verschiedenen Seiten, doppelte Labels, Pfeilrichtungen |
| 3 — Abruf/Antwort | Lokales Unicode-BM25, Textabschnitte, Metadaten, direkte Nachbarn, begrenzter Überblick, Pagination, gezielter Node-/Snapshotabruf, Belege aus tatsächlich übergebenen Auszügen | Kein-Treffer-Verhalten, exakte Zitate, unbekannte Beleg-IDs, Metadatentreffer, Gesamtbudget einschließlich strukturierter Ausgabe |
| 4 — Betrieb | Privater validierter Cache v4, getrennte Quell-/Interpretationsartefakte, atomare Veröffentlichung, Prozesssperre, selektive Vision-Wiederholung, Metadatenprüfung, Abbruch, Ressourcenlimits | Zwei unabhängige Writer, beschädigte Dateien, v3-Neuingest, Modellwechsel ohne Board-Diff, Abbruch nach Staging vor Veröffentlichung, fehlende Renderings |
| 5 — MCP/Release | Stabiles TypeScript-SDK v2, fünf Tools mit Annotations, modernes und älteres stdio, isolierte Produktionsinstallation, Registry-/Glama-Dateien, CI-Matrix, Release-Kandidat-Workflow | Tatsächliche Toolaufrufe und Fehlerfälle, ausgehandelte Protokollversionen, Node 22/24, Paketinhalt |

Die Sicherheitsreparatur innerhalb SDK v1 wurde vor der v2-Migration geprüft.
Das Endergebnis verwendet `@modelcontextprotocol/server` 2.3.1, Zod 4 und Vitest 5;
der MCP-Client ist ausschließlich Testabhängigkeit. Die Erhöhung auf Node 22.12
berücksichtigt auch die Mindestanforderungen des aktualisierten Testwerkzeugs.
Der abschließende npm-Abgleich fand **0 gemeldete Schwachstellen** im gesamten
Abhängigkeitsbaum; es werden keine Meldungen pauschal unterdrückt. Das ist ein
zeitpunktbezogenes Datenbankergebnis, keine Behauptung vollständiger Fehlerfreiheit.

## Nachvollziehbare Qualität

`npm run eval:retrieval` prüft 20 synthetische Boards und 20 zugehörige Änderungen.
Im gemessenen lokalen Offline-Lauf:

- 18/18 vorhandene Zielquellen auf Rang 1 und damit auch innerhalb der ersten 3.
- 2/2 Fragen ohne Quelle liefern keine Treffer.
- 20/20 Revisionen entsprechen den erwarteten Änderungen, einschließlich Tabellenzellen und internen Pfeilen.
- 0 externe API-Aufrufe und kein Modellverbrauch.
- Indexaufbau plus Suche: Median 0,072 ms, 95. Perzentil 1,350 ms, Maximum 3,923 ms auf diesem Rechner. Die sehr kleinen synthetischen Boards bilden keine Produktionslast ab. Die [Messdaten](2026-10-08-retrieval-evaluation.json) enthalten alle Fälle und Soll-/Iständerungen.

Der Sichtbarkeitsvergleich mit dem früheren Prinzip „erste fünf Texte, jeweils
120 Zeichen“ findet 15/18 Fakten. Das ist ausdrücklich ein **Proxy für den
damaligen Informationsverlust**, kein ausgeführter historischer Benchmark der
gesamten alten Pipeline. Eine echte Ausgangsmessung mit freigegebenen realen
Boards und Modellen wurde nicht nachträglich behauptet.

`npm run eval:retrieval -- --with-llm` ist der ausdrücklich aktivierte externe
Lauf. Er misst tatsächliche SDK-Anfragen, vom Anbieter gemeldete Tokens,
Antwortlaufzeiten, Quellenabdeckung und strukturelle Beleggültigkeit. Fehlende
Verbrauchsangaben bleiben unbekannt; Geldbeträge werden nicht ausgedacht. Dieser
Modus wurde mit lokalen Anbieter-Stubs getestet, aber nicht gegen einen externen
Anbieter ausgeführt. Die sprachliche Schlussfolgerung einer Antwort wird durch
eine gültige Quellen-ID allein nicht bewiesen.

## Betrieb und Migration

- Quellidentität hängt am erfassten Boardinhalt. Modell-, Prompt- und Providerwechsel betreffen die getrennten Interpretationsrevisionen.
- Veröffentlichung erfolgt durch atomaren Austausch des Manifests. Ein davor abgebrochener erneuter Ingest überschreibt auch bei gleicher Inhalts-/Konfigurationsidentität keine vorhandene Interpretation.
- Ein nach Prozessabsturz verbliebener Schreib-Lock wird nicht automatisch übernommen. Nach Stoppen aller Server kann ausschließlich `v4/.write-lock` entfernt werden; der genaue Pfad steht im README.
- Die v3-Historie bleibt erhalten; neue Vergleiche beginnen nach erneutem Ingest in v4.
- Kontextausgaben sind einschließlich der strukturierten Wiederholung auf 128 KiB begrenzt. Kürzungen und ausstehende Quellen sind sichtbar; Cursor binden Abfrage, Snapshot und Ergebnisstand.
- Der aktuelle Dokumentationsabgleich bestätigt den [Metadatenendpunkt und Scope](https://developers.figma.com/docs/rest-api/file-endpoints/) sowie die [separaten Tabellenzelltexte](https://developers.figma.com/docs/rest-api/file-node-types/). Fehlende Bild-URLs gelten als unvollständiges Rendering.

## Grenzen der Abnahme

Die vollständige Paketprüfung einschließlich Typprüfung, Tests, Build,
Paketkontrolle und isolierter Installation mit ausschließlich Produktionspaketen
bestand lokal unter **Node 22.23.3 und Node 24.18.0**. Alle fünf Tools wurden
erfolgreich durch den installierten stdio-Prozess ausgeführt; Figma und
Modellanbieter waren dabei kontrollierte Offline-Fixtures. Fehlerpfade und
fehlende Schlüssel wurden zusätzlich geprüft. Die tatsächlich ausgehandelten
Protokolle waren **2026-07-28**, **2025-11-25** und **2025-06-18**.

Der [gepackte Release-Kandidat](../../.cache/release/figjam-context-mcp-0.4.0.tgz)
liegt lokal bereit (355.747 Bytes, npm SHA-1
`ca092226471d1b8b02341b227452a0d6aa8944c0`). Das Archiv wurde nach den erfolgreichen
Paketprüfungen aus dem geprüften Build erstellt; es enthält weder private
Umgebungsdateien noch Tests oder Entwicklungsabhängigkeiten.

Die CI-Matrix ist für Linux, macOS und Windows mit Node 22/24 konfiguriert.
Lokale Prüfungen auf macOS ersetzen keinen ausgeführten GitHub-CI-Lauf auf den
anderen Plattformen. Es wurden weder npm-Veröffentlichung noch GitHub-Release,
Registry-Upload oder Glama-Neuerfassung ausgelöst. Eine bestimmte Glama-Note
bleibt außerhalb der technischen Abnahmekriterien.

Die vorab vorhandene README-Ergänzung und das lokale GIF-Erzeugungsskript wurden
erhalten. Die Änderungen bleiben zur Prüfung im Arbeitsverzeichnis verfügbar.
