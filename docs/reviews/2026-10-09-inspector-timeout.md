# Inspector: Timeout trotz abgeschlossenem Ingest

## Beobachtung am 9. Oktober 2026

In Inspector 2.10.1 unter Safari meldete ein `max_quality`-Ingest mit
`forceFullIngest=true` nach dem letzten Fortschritt einen 60-Sekunden-Timeout.
Der laufende Inspector verwendete nachweislich `--config inspector.config.json`
mit `requestTimeout: 180000`; die aktive Verbindung hieß `figjam-local` und
verwendete stdio mit Protokollversion `2025-11-25`.

Die Pipeline meldete nach ungefähr 32 Sekunden `progress: 5`, `total: 5`,
`message: complete`. Der gespeicherte v4-Stand bestätigte den Abschluss:
297 Cluster, davon 3 visuell interpretiert, 294 wegen des Vision-Zeitbudgets
zurückgestellt und 0 wiederverwendet. Der erzwungene Neuaufbau hatte die
vorherigen erfolgreichen Interpretationen für diesen Lauf nicht übernommen.

Eine spätere reine `get_board_context`-Abfrage über dieselbe Verbindung antwortete
in 285 ms. Dabei wechselte auch der vorherige Ingest-Eintrag auf `OK` mit
612.163 ms angezeigter Laufzeit. Seine nachträglich sichtbare Antwort enthielt
das Ingest-Ergebnis, einschließlich Zusammenfassung und Qualitätsbericht.

Das belegt den gespeicherten Abschluss und die verspätete Anzeige/Zustellung.
Es beweist noch nicht, an welcher Stelle zwischen Prozessausgabe, Web-Relay und
Safari die Antwort zurückgehalten wurde.

## Abgrenzung

- Das tatsächliche Ergebnis bestand die lokale Ausgabeschema-Prüfung und war nur
  ungefähr 1 KiB groß.
- Lokale Replays über `serveStdio` lieferten alle sechs Fortschrittsmeldungen und
  die abschließende Antwort unter `2025-11-25` und `2025-06-18` ohne weitere
  Client-Anfrage. Die Antwort folgte `complete` im Rohdaten-Test nach etwa 3 ms.
- Auch der von Inspector installierte SDK-Client 2.2.0 las Abschlussmeldung und
  Ergebnis sofort, wenn beide in demselben stdout-Block standen.
- Isolierte Prüfungen des installierten Web-Relays und SSE-Parsers reproduzierten
  keine Verzögerung durch Nachrichtenreihenfolge oder Blockgrenzen.
- Im sichtbaren Inspector-Protokoll war keine `notifications/cancelled`-Meldung
  vorhanden. Das allein schließt jeden anderen Abbruchpfad nicht aus.
- Der Inspector-Webpfad besitzt neben dem konfigurierbaren SDK-Timeout zwei
  separate 60-Sekunden-Wartezeiten (Backend und Browser-Transport), die durch
  Fortschrittsmeldungen zurückgesetzt werden. `requestTimeout: 180000` steuert
  diese beiden Wartezeiten in der untersuchten Version nicht.

Die Diagnose führte keine neuen Figma- oder Modellaufrufe aus. Geprüft wurden
lokale gespeicherte Daten, synthetische Nachrichten und eine lokale Quellenabfrage.

## Verfügbarer Ausweichweg

Der Inspector-CLI-Modus verwendet stdio direkt und umgeht den Web-Relay-/Browserpfad.
Die README enthält den Aufruf. Dieser Transportpfad wurde lokal überprüft; ein
neuer vollständiger externer Max-Quality-Ingest wurde dabei nicht behauptet.

Ein Server-Patch oder periodische zusätzliche Nachrichten wären ohne reproduzierten
Fehler voreilig. Die genaue Ursache im realen Webpfad bleibt offen. Vor Freigabe
der Web-Inspector-Testanleitung ist dieser Ablauf erneut zu prüfen.

## Ergänzende Prüfung im vollständigen Webpfad

Eine isolierte Instanz des unveränderten offiziellen Inspector 2.10.1 wurde mit
einem rein synthetischen stdio-Server betrieben. Sie verwendete weder das echte
Board noch dessen Cache oder Modellschlüssel. Der tatsächliche HTTP-Relay lieferte:

| Test | Ergebnis |
| --- | --- |
| Sofortiger Abschluss, getrennte Ausgabe | Ergebnis 5 ms nach `complete` |
| 32 Sekunden, `complete` und Ergebnis im selben stdout-Block | Ergebnis ohne messbare Verzögerung nach `complete` |
| 65 Sekunden mit Fortschritt | Erfolgreiches Ergebnis ohne Folgeanfrage |
| 65 Sekunden ohne Fortschritt | HTTP-Wartezeit nach 60.003 ms abgelaufen; ursprüngliches Ergebnis erreichte den offenen Ereignisstrom trotzdem nach 65.121 ms |

Das reproduziert die zusätzliche 60-Sekunden-Grenze, aber nicht die ursprüngliche
Verzögerung einer bereits nach ungefähr 32 Sekunden fertigen Verarbeitung.
Keiner der erfolgreichen Fälle benötigte einen zweiten Toolaufruf.

Anschließend wurde derselbe 32-Sekunden-Test in Safari über die vollständige
Inspector-Oberfläche ausgeführt: Nach **32.114 ms** erschienen `OK`, der finale
Antworttext und die strukturierte Ausgabe ohne weitere Toolanfrage.
Der anschließende 65-Sekunden-Test mit Fortschritt erschien nach **65.114 ms**
ebenfalls als `OK`, einschließlich Antworttext und strukturierter Ausgabe.
Die Testoberfläche wurde danach geschlossen und der isolierte Testserver beendet.
Der ursprüngliche Fehler bleibt damit unaufgeklärt; die aktuelle Prüfung belegt
keine allgemeine Fehlerfreiheit des Browserpfads.

Auch die echte `figjam-local`-Verbindung wurde über die Oberfläche getrennt und
neu verbunden. Ein reiner `get_board_context`-Abruf antwortete danach in **319 ms**
aus demselben gespeicherten Snapshot. Für den Neustart war kein Ingest nötig.

Lokale Reproduktionsdateien und HTTP-Messungen liegen unter
`.cache/inspector-web-repro/`; darin enthaltene kurzlebige lokale Zugangsdaten
sind kein Bestandteil des npm-Pakets oder eines Repository-Uploads.
