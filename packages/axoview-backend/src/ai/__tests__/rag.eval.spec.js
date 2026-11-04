/**
 * Retrieval evaluation: questions a user would type, and the manual section
 * that answers each. No model is involved; this checks that retrieval puts the
 * right evidence in front of the model at all.
 *
 * CASES were written alongside the manual's section keywords: they are the
 * regression set. When one fails, fix the manual's wording or keywords first,
 * the ranking second.
 *
 * HELD_OUT was written after the keywords and must not be tuned against: it is
 * the honest measure of how well lexical search generalises. Baseline at
 * introduction (BM25, 50 chunks): 17/20 in the top 3, 9/20 first. When it drops
 * below the gate, or the manual grows past a few hundred sections, that is the
 * signal to add embeddings (docs/ai/rag.md).
 */
import { describe, expect, test } from '@jest/globals';
import { rankKnowledge, retrievePublicKnowledge } from '../rag.js';

const CASES = [
  ['How do I connect two servers with a line?', 'connectors-connecting-two-items'],
  ['how to draw an arrow between items', 'connectors-connecting-two-items'],
  ['change a connector to dashed', 'connectors-connector-colour-and-line-style'],
  ['how do I add a waypoint to bend a connector', 'connectors-rerouting-a-connector'],
  ['remove a waypoint from a connection', 'connectors-rerouting-a-connector'],
  ['put a label on a connection', 'connectors-naming-a-connector-and-adding-labels'],
  ['where are the AWS icons', 'nodes-icon-packs'],
  ['add a database icon to my diagram', 'nodes-adding-an-item'],
  ['can I upload my own icon png', 'nodes-importing-your-own-icons'],
  ['what is the difference between name and label', 'nodes-name-and-label'],
  ['change the icon of a node', 'nodes-changing-an-item-s-icon'],
  ['draw a box around my VPC', 'shapes-and-text-drawing-a-rectangle'],
  ['make a bulleted list in a text box', 'shapes-and-text-formatting-text-in-a-text-box'],
  ['hide a layer', 'organising-layers'],
  ['bring an item to the front', 'organising-stacking-order'],
  ['items overlap each other, turn off collision', 'organising-snap-to-grid-and-collision'],
  ['rotate the isometric view', 'canvas-rotating-the-isometric-view'],
  ['switch to a flat 2D view', 'canvas-switching-between-2d-and-isometric'],
  ['how do I move around the canvas', 'canvas-panning-moving-around'],
  ['select multiple items at once', 'canvas-selecting-items'],
  ['undo my last change', 'canvas-undo-and-redo'],
  ['export my diagram as a PNG image', 'sharing-and-export-exporting-an-image'],
  ['back up all my diagrams as a zip', 'sharing-and-export-exporting-a-diagram-file-or-a-whole-project'],
  ['import a json file', 'sharing-and-export-importing'],
  ['share a read only link with my team', 'sharing-and-export-sharing-a-view-only-link'],
  ['present my diagram in a meeting', 'sharing-and-export-presenting'],
  ['draw on the diagram while presenting', 'sharing-and-export-annotating'],
  ['add another page to the diagram', 'getting-started-pages'],
  ['how do I save', 'getting-started-saving'],
  ['what keyboard shortcuts are there for tools', 'settings-and-shortcuts-tool-keys'],
  ['change the language', 'settings-and-shortcuts-settings'],
  ['how many AI messages can I send per day', 'ai-assistant-limits'],
  ['does the assistant see my diagram', 'ai-assistant-getting-suggestions-for-your-diagram']
];

const HELD_OUT = [
  ['my lines are too thin, make them thicker', 'connectors-connector-colour-and-line-style'],
  ['I want a kubernetes pod icon', 'nodes-icon-packs'],
  ['how can I show where my private subnet is', 'shapes-and-text-drawing-a-rectangle'],
  ['send the diagram to someone without letting them edit', 'sharing-and-export-sharing-a-view-only-link'],
  ['the text under my server icon is wrong', 'nodes-name-and-label'],
  ['can I write notes on a node that are not shown', 'nodes-item-details-and-notes'],
  ['diagram is too big, I cannot see everything', 'canvas-zooming'],
  ['download an svg', 'sharing-and-export-exporting-an-image'],
  ['where did my diagrams go after I log in', 'getting-started-signing-in'],
  ['put the database behind the server icon', 'organising-stacking-order'],
  ['the end of my arrow is not attached to anything', 'connectors-attaching-a-loose-end'],
  ['make a legend explaining colours', 'shapes-and-text-adding-a-text-box'],
  ['is my chat history stored', 'ai-assistant-what-is-sent-and-kept'],
  ['open a diagram from a file on my computer', 'sharing-and-export-importing'],
  ['turn on azure icons', 'nodes-icon-packs'],
  ['keyboard shortcut to delete', 'settings-and-shortcuts-editing-shortcuts'],
  ['link a node to another diagram', 'nodes-linking-an-item'],
  ['change text colour of a label', 'nodes-showing-hiding-and-styling-a-label'],
  ['create a folder for my diagrams', 'getting-started-the-diagrams-panel'],
  ['make the connection go around another icon', 'connectors-rerouting-a-connector']
];

describe('manual retrieval', () => {
  test.each(CASES)('%s -> %s in the top 3', (question, expected) => {
    const ids = retrievePublicKnowledge(question).map((doc) => doc.id);
    expect(ids).toContain(expected);
  });

  test('top-1 accuracy stays above 80%', () => {
    const hits = CASES.filter(([question, expected]) => rankKnowledge(question)[0]?.item.id === expected);
    expect(hits.length / CASES.length).toBeGreaterThanOrEqual(0.8);
  });

  test('held-out questions: at least 80% have the answer in the top 3', () => {
    const hits = HELD_OUT.filter(([question, expected]) =>
      retrievePublicKnowledge(question).some((doc) => doc.id === expected));
    expect(hits.length / HELD_OUT.length).toBeGreaterThanOrEqual(0.8);
  });

  test('an off-topic question retrieves nothing', () => {
    expect(retrievePublicKnowledge('weather forecast Paris tomorrow')).toEqual([]);
  });
});
