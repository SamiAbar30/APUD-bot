/**
 * The limits every brain reply is checked against. These are pure functions over text, so they are
 * tested directly; the brain's judgement itself is measured live by scripts/training/train.ts.
 */
import assert from 'node:assert/strict';
import { checkReply, checkDecision, similarity } from '../src/core/conversation-brain.js';

const history = [
  { role: 'assistant' as const, content: 'Es la aplicación donde instalaste el certificado; ábrela y busca «copia de seguridad» o «exportar». Si no la encuentras, dime qué ves y lo miramos.' },
  { role: 'user' as const, content: 'es que no se en donde mirar' },
];

// The exact loop from the manager's test on 23 Sep must be refused as a repeat.
assert.match(checkReply('Es la aplicación donde instalaste el certificado; ábrela y busca «copia de seguridad» o «exportar». Si no la encuentras, dime qué ves y lo miramos.', history, 'x') ?? '', /ya se lo dijiste/);
// A different, concrete step is fine.
assert.equal(checkReply('En el móvil busca la app «Certificado Digital» de la FNMT, icono azul. Dentro verás «Mis Certificados Instalados».', history, 'x'), null);
// Approved links and amounts pass; invented ones do not.
assert.equal(checkReply('Entra en https://sedejudicial.justicia.es/-/apoderamiento-apud-acta por «Certificado Digital».', [], 'x'), null);
assert.match(checkReply('Entra en https://sede-falsa.example.com/apud y sigue los pasos.', [], 'x') ?? '', /enlace/);
assert.equal(checkReply('La empresa colaboradora lo hace por ti por 35 €.', [], 'x'), null);
// Round 1 bug: a comma decimal was read as 62 € and valid replies were thrown away.
assert.equal(checkReply('Con la app de la FNMT cuesta 3,62 €.', [], 'x'), null);
assert.match(checkReply('La empresa colaboradora lo hace por ti por 50 €.', [], 'x') ?? '', /importes/);
// Never ask for codes or bank data; saying not to send them is fine.
assert.match(checkReply('Mándame el código SMS que te ha llegado y lo reviso.', [], 'x') ?? '', /SMS/);
assert.equal(checkReply('No me mandes nunca códigos SMS ni el PIN.', [], 'x'), null);
// The office's certificate route is allowed (protocol 1.2 / 2.2).
assert.equal(checkReply('Si quieres lo hago yo: mándame por aquí el archivo del certificado y, en otro mensaje, su contraseña.', [], 'x'), null);
// No completion claims, one question at most, not claiming to be human.
assert.match(checkReply('Ya hemos recibido tu apoderamiento, gracias.', [], 'x') ?? '', /no te consta/);
assert.match(checkReply('¿Lo tienes en el móvil? ¿O en el ordenador?', [], 'x') ?? '', /una pregunta/);
assert.match(checkReply('Tranquilo, soy una persona del despacho.', [], 'x') ?? '', /asistente virtual/);
// Only reachable workflow steps can be chosen.
assert.match(checkDecision({ accion: 'COURT_APPOINTMENT', mensaje: '' }, new Map(), [], 'x') ?? '', /no está disponible/);
assert.equal(checkDecision({ accion: 'SILENCIO', mensaje: '' }, new Map(), [], 'x'), null);
assert.ok(similarity('abre la app certificado digital y busca mis certificados instalados', 'abre la app certificado digital y busca mis certificados instalados') > 0.95);

// Round 4: the claims e-mail repeated on every turn of a Sede walkthrough.
const mailed = [1, 2].map(() => ({ role: 'assistant' as const, content: 'La carta mándala a reclamaciones@litigios.es y seguimos.' }));
assert.match(checkReply('Marca las dos opciones. La carta, a reclamaciones@litigios.es.', mailed, 'ya he marcado, ¿y ahora?') ?? '', /correo/);
assert.equal(checkReply('Es reclamaciones@litigios.es, sí.', mailed, '¿a qué correo la mando?'), null);
console.log(JSON.stringify({ result: 'PASS', suite: 'brain-guards' }));
