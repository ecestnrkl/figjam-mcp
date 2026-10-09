import type { BoardData } from "../../src/types.js";
import { evidenceBoard, textNode } from "./retrieval.js";

/** Synthetic acceptance cases. Expected behavior needs human review of a real model response. */
export const answerGroundingFixtures: Array<{
  name: string;
  board: BoardData;
  query: string;
  expectedStatus: "unknown" | "confirmed" | "denied" | "conflicting";
  expectedBehavior: string;
}> = [
  {
    name: "open availability task does not establish booking status",
    board: evidenceBoard("GroundingOpen123", [
      { ...textNode("1:1", "Simulatorverfügbarkeit klären"), name: "Simulator" },
    ]),
    query: "Ist der Simulator bereits verbindlich gebucht?",
    expectedStatus: "unknown",
    expectedBehavior: "State that booking status is not established by the excerpt. The open availability task proves neither a booking nor the absence of a booking; it may be quoted to explain the uncertainty.",
  },
  {
    name: "explicit confirmed booking supports a positive answer",
    board: evidenceBoard("GroundingConfirmed123", [textNode("1:1", "Der Simulator ist für Freitag verbindlich gebucht.")]),
    query: "Ist der Simulator für Freitag verbindlich gebucht?",
    expectedStatus: "confirmed",
    expectedBehavior: "Confirm that the board explicitly records a binding booking for Friday and cite that source. Do not invent a booking reference or other details.",
  },
  {
    name: "explicit absence of booking supports a negative answer",
    board: evidenceBoard("GroundingDenied123", [textNode("1:1", "Der Simulator ist für Freitag nicht gebucht.")]),
    query: "Ist der Simulator für Freitag gebucht?",
    expectedStatus: "denied",
    expectedBehavior: "State that the board explicitly records no booking for Friday and cite that source. Do not weaken an explicit negative into mere lack of evidence.",
  },
  {
    name: "proposed booking is not completed booking",
    board: evidenceBoard("GroundingProposal123", [textNode("1:1", "Vorschlag: Simulator für Freitag buchen?")]),
    query: "Ist der Simulator für Freitag bereits verbindlich gebucht?",
    expectedStatus: "unknown",
    expectedBehavior: "Explain that the source is a proposal or question, so whether a binding booking exists remains unknown. Do not treat the proposal as either confirmation or denial.",
  },
  {
    name: "conflicting booking records remain unresolved",
    board: evidenceBoard("GroundingConflict123", [
      textNode("1:1", "Der Simulator ist für Freitag verbindlich gebucht."),
      textNode("1:2", "Der Simulator ist für Freitag nicht gebucht."),
    ]),
    query: "Ist der Simulator für Freitag verbindlich gebucht?",
    expectedStatus: "conflicting",
    expectedBehavior: "Identify the contradictory booking records and cite both. With no dates or supersession information, do not choose one as the current truth.",
  },
];
