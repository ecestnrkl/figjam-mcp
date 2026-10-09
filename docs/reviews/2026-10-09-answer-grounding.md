# Abnahme von Statusantworten

Bei der manuellen Prüfung wurde aus einer offenen Aufgabe zur Klärung einer
Verfügbarkeit eine negative Buchungsaussage abgeleitet. Die Quellenreferenz
konnte dabei korrekt sein, obwohl sie diese Schlussfolgerung nicht belegte.
Dieser Fall bestand die inhaltliche Abnahme nicht.

Die Antwortanweisung unterscheidet jetzt ausdrücklich bestätigte Angaben,
explizite Verneinungen, offene Aufgaben, Vorschläge und widersprüchliche Quellen.
Aus „Verfügbarkeit klären“ darf weder eine bestätigte noch eine ausgeschlossene
Buchung folgen. Zulässig ist: „Eine verbindliche Buchung ist durch diesen Eintrag
nicht belegt.“ Die offene Aufgabe darf als Quelle dieser Erklärung genannt werden.

## Nachprüfung

Den MCP-Prozess nach der Änderung neu starten und die Statusfrage im Inspector
wiederholen. Ein erneuter Ingest ist für die geänderte Antwortanweisung unnötig.
In der Antwort müssen Aussage und Unsicherheit zu den tatsächlich angeführten
Quellen passen. Insbesondere darf ein einleitendes „Nein“ nicht anschließend
durch „deutet darauf hin“ scheinbar abgesichert werden.

Die getrennten synthetischen Statusfälle im expliziten Modell-Evaluationslauf
prüfen außerdem bestätigte, ausdrücklich verneinte, vorgeschlagene und
widersprüchliche Angaben. Der Bericht zeigt Erwartung und erzeugte Antwort zur
menschlichen Prüfung. Gültige Quellen-IDs oder erfolgreiche Offline-Tests werden
nicht als bestandene inhaltliche Modellprüfung gewertet.

Nach der Änderung wiederholte der Nutzer die beiden manuellen Gegenproben:
Die Buchungsfrage blieb ausdrücklich unbelegt; die Frage nach der dokumentierten
Aufgabe lieferte den Originaltext mit übereinstimmender Node-ID, Snapshot und
Figma-Link. Beide Fälle bestanden damit ihre inhaltliche und strukturelle Prüfung.

Die Abnahme mit fünf synthetischen Anbieterfällen ist im
[separaten Abnahmebericht](2026-10-09-acceptance.md) dokumentiert. Die erneute
inhaltliche Durchsicht bewertet alle fünf Statusentscheidungen als korrekt;
vier erfüllen die ursprünglichen Erwartungen vollständig. Beim Vorschlagsfall
fehlt trotz korrekter Unsicherheit und Quelle noch die ausdrückliche Erklärung
„nur ein Vorschlag“. Die Promptänderung ist weiterhin keine
deterministische Garantie gegen unbelegte Schlussfolgerungen.
