import assert from "node:assert/strict";

import { checkSources, dataKinds, dataZoneOf, forbiddenTexts, statedByOwner, withAbsentLabels } from "./recreate-reference.js";
import { registerVocabulary, unregisterVocabulary, vocabularyFor, type PosterVocabulary } from "./poster-vocabulary.js";

// Fictional poster in a language that ships no table: times, dates, labels and "absent" are only recognised
// once that one table is registered.
const FR: PosterVocabulary = {
  timeUnits: ["heures"],
  months: ["janv", "fevr", "mars", "avr", "juin", "juil", "sept", "oct", "nov", "dec"],
  dateConnectors: [],
  currencyWords: ["euro"],
  stopWords: ["avec", "pour", "dans", "les", "des"],
  labels: { place: ["lieu", "salle"], time: ["horaire"], entry: ["entree"], price: ["prix"], date: ["date"] },
  mentions: { place: ["lieu"], time: ["horaire", "heure"], entry: ["entree", "prix"], price: ["prix"], date: ["date", "jour"] },
  negations: ["pas", "sans", "aucun"],
  streetWords: ["rue", "boulevard"],
};

const LINES = { time: "Concert 21 heures", date: "Samedi 12 fevrier", label: "Horaire", entryLabel: "Entrée" };
const owner = ["pas de prix, le horaire est libre"];
const frTexts = () => [{ zone: "price" as const, text: "", from: "absent" as const }];

{
  assert.deepEqual(dataKinds(LINES.time), [], "no table: the unit word is not a time");
  assert.deepEqual(dataKinds(LINES.date), [], "no table: the month word is not a date");
  assert.equal(dataZoneOf(LINES.label), undefined, "no table: the label means nothing");
  assert.equal(dataZoneOf("Entrée"), undefined);
  assert.equal(checkSources(frTexts(), owner, [], "fr-FR")[0]!.from, "missing", "no table: absence is not understood, the datum is asked for");
  assert.equal(statedByOwner("avec Marie Dupont", ["Marie Dupont"], "fr"), false, "no table: the stop word counts");

  registerVocabulary("fr", FR);
  try {
    assert.deepEqual(dataKinds(LINES.time), ["time"]);
    assert.deepEqual(dataKinds(LINES.date), ["date"]);
    for (const [label, zone] of [["Lieu", "place"], ["Horaire", "time"], ["Entrée", "entry"], ["Prix", "price"], ["Date", "date"]] as const) {
      assert.equal(dataZoneOf(label), zone, label);
    }
    assert.equal(dataZoneOf("Rue Exemple 12"), "place", "street words");
    assert.equal(checkSources(frTexts(), owner, [], "fr-FR")[0]!.from, "absent", "the owner said the datum is absent");
    assert.equal(dataZoneOf("Tickets"), "entry", "the English table is merged in: posters borrow its labels");
    assert.deepEqual(forbiddenTexts([{ zone: "title", text: "Nouveau", from: "content", original: "Horaire" }]), [], "a label is never forbidden");
    const lines = [
      { text: "Horaire", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.03 } },
      { text: "Concert", box: { x: 0.1, y: 0.14, w: 0.3, h: 0.04 } },
    ];
    const gone = withAbsentLabels(
      [{ zone: "label", text: "Horaire", from: "layout", line: 0 }, { zone: "time", text: "", from: "absent", line: 1 }],
      lines,
    );
    assert.equal(gone[0]!.from, "absent");
    assert.equal(statedByOwner("avec Marie Dupont", ["Marie Dupont"], "fr"), true, "the table's stop words are ignored");
  } finally {
    unregisterVocabulary("fr");
  }
  assert.deepEqual(dataKinds(LINES.time), [], "unregistered: back to nothing");
}

{
  assert.equal(vocabularyFor("es"), vocabularyFor("es-XX"), "a regional tag resolves by its language, one compiled copy");
  assert.equal(vocabularyFor("ES_xx"), vocabularyFor("es"), "the language subtag is case-insensitive");
  assert.equal(vocabularyFor("en-US"), vocabularyFor("en"));
  assert.notEqual(vocabularyFor("es"), vocabularyFor("en"));
  assert.equal(vocabularyFor(undefined), vocabularyFor("xx"), "unknown language and no locale both use the union");
  assert.equal(vocabularyFor("xx-YY"), vocabularyFor(""));

  // The layout side reads every shipped table, whatever the brand's language.
  assert.equal(dataZoneOf("Ubicacion"), "place");
  assert.equal(dataZoneOf("Location"), "place");
  assert.equal(dataZoneOf("Tickets"), "entry");
  assert.deepEqual(dataKinds("21 horas"), ["time"]);
  assert.deepEqual(dataKinds("12 sept 5 dollars"), ["price", "date"]);
  assert.deepEqual(dataKinds("3 de ene"), ["date"]);
  assert.deepEqual(dataKinds("3 pesos"), ["price"]);
  assert.deepEqual(dataKinds("21:30 pm"), ["time"]);
  assert.equal(dataZoneOf("Calle Ejemplo 12"), "place");
  // The owner side follows the brand's language (plus English).
  const absent = (locale?: string) => checkSources([{ zone: "price", text: "", from: "absent" }], ["sin precio"], [], locale)[0]!.from;
  assert.equal(absent("en"), "missing", "en has no Spanish negation");
  assert.equal(absent("es"), "absent");
  assert.equal(absent("es-XX"), "absent");
  assert.equal(absent(), "absent");
  assert.equal(absent("xx"), "absent", "unknown language: union");
  assert.equal(statedByOwner("desde Marie Dupont", ["Marie Dupont"], "es"), true, "es stop words are ignored");
  assert.equal(statedByOwner("desde Marie Dupont", ["Marie Dupont"], "en"), false, "en does not ignore them");
}
console.log("ok - poster-vocabulary");
