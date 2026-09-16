'use strict';

/** State-specific operator controls. No client secrets are persisted by this module. */
function renderCaseTools(c, capabilities = {}) {
  capabilities = capabilities || {};
  const root = document.createElement('section');
  root.className = 'case-tools';
  root.setAttribute('aria-label', 'Gestiones con evidencia del expediente');
  let busy = false;
  const savedDisabled = new Map();
  const casePath = `/api/cases/${encodeURIComponent(c.id)}`;
  const documents = Array.isArray(c.documents) ? c.documents : [];
  const currentDocument = documents.find(document => document.id === c.documentId);
  const draft = currentDocument?.documentType === 'BORRADOR_SEDE' ? currentDocument : null;
  const logs = Array.isArray(c.auditLogs) ? c.auditLogs : [];
  const dateText = value => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin fecha verificada';
  };

  function paragraph(parent, message, className) {
    const element = document.createElement('p');
    element.textContent = message;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }
  function tool(title, description) {
    const details = document.createElement('details');
    details.className = 'detail-section';
    const summary = document.createElement('summary');
    const heading = document.createElement('strong');
    heading.textContent = title;
    summary.append(heading);
    details.append(summary);
    paragraph(details, description);
    root.append(details);
    return details;
  }
  function form(parent) {
    const element = document.createElement('form');
    element.className = 'form-grid';
    element.autocomplete = 'off';
    parent.append(element);
    return element;
  }
  function field(parent, name, labelText, options = {}) {
    const label = document.createElement('label');
    label.append(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.name = name;
    input.type = options.type || 'text';
    input.required = options.required !== false;
    input.autocomplete = options.autocomplete || 'off';
    input.maxLength = options.maxLength || 200;
    if (options.minLength) input.minLength = options.minLength;
    if (options.pattern) input.pattern = options.pattern;
    if (options.inputMode) input.inputMode = options.inputMode;
    if (options.accept) input.accept = options.accept;
    if (options.readOnly) input.readOnly = true;
    if (options.value != null) input.value = String(options.value);
    label.append(input);
    parent.append(label);
    return input;
  }
  function check(parent, name, text) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.required = true;
    label.append(input, document.createTextNode(text));
    parent.append(label);
    return input;
  }
  function button(parent, text, type = 'submit') {
    const element = document.createElement('button');
    element.type = type;
    element.className = type === 'submit' ? 'primary' : 'secondary';
    element.textContent = text;
    parent.append(element);
    return element;
  }
  function operatorFields(parent) {
    return {
      operatorId: field(parent, 'operatorId', 'Nombre del gestor que registra la evidencia', { minLength: 3, maxLength: 100 }),
      evidenceRef: field(parent, 'evidenceRef', 'Referencia del justificante o de la comunicación comprobada', { minLength: 5, maxLength: 200 }),
    };
  }
  function evidenceValues(fields) {
    return { operatorId: fields.operatorId.value.trim(), evidenceRef: fields.evidenceRef.value.trim() };
  }
  function assertCurrent() {
    if (!selected || selected.id !== c.id || selected.version !== c.version) {
      throw new Error('El expediente ha cambiado. Abre de nuevo su ficha antes de guardar.');
    }
  }
  function setBusy(value) {
    busy = value;
    root.setAttribute('aria-busy', String(value));
    if (value) {
      for (const control of root.querySelectorAll('input,select,textarea,button')) {
        savedDisabled.set(control, control.disabled);
        control.disabled = true;
      }
    } else {
      for (const [control, disabled] of savedDisabled) control.disabled = disabled;
      savedDisabled.clear();
    }
  }
  async function reload(message) {
    notify(message);
    const dialog = document.getElementById('case-dialog');
    if (selected?.id === c.id && dialog?.open) await openCase(c.id);
    await refresh();
  }
  function bind(target, path, values, message) {
    target.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !target.reportValidity()) return;
      try {
        assertCurrent();
        const body = { version: c.version, ...values() };
        setBusy(true);
        await api(`${casePath}${path}`, { method: 'POST', body });
        target.reset();
        await reload(message);
      } catch (error) {
        notify(error instanceof Error ? error.message : 'No se pudo guardar la gestión.');
      } finally { setBusy(false); }
    });
  }
  function reference(parent, document) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    const title = document.createElement('strong');
    title.textContent = 'Borrador vigente';
    const hash = document.createElement('code');
    hash.textContent = `SHA-256 ${document.sha256Hash}`;
    card.append(title, hash);
    parent.append(card);
  }

  if (c.currentState === 'MOBILE_ASSIST_CONSENT_REQUESTED') {
    const section = tool('Registrar el consentimiento del cliente', 'Vincula la aceptación expresa del cliente al texto de asistencia aprobado por el despacho.');
    const target = form(section);
    const fields = operatorFields(target);
    const approvedVersion = typeof capabilities.consentVersion === 'string' ? capabilities.consentVersion : '';
    const consentVersion = field(target, 'consentVersion', 'Versión aprobada del consentimiento', { maxLength: 100, value: approvedVersion, readOnly: Boolean(approvedVersion) });
    const confirmed = check(target, 'clientConsentGranted', 'He comprobado que el cliente acepta expresamente el uso de su certificado para preparar el borrador.');
    button(target, 'Registrar consentimiento');
    if (capabilities.consentConfigured === false) {
      paragraph(section, 'Falta configurar el texto de consentimiento aprobado.', 'danger');
      target.querySelector('button').disabled = true;
    }
    bind(target, '/consent', () => ({ ...evidenceValues(fields), consentVersion: consentVersion.value.trim(), clientConsentGranted: confirmed.checked }), 'Consentimiento registrado. Comprueba la dirección antes de iniciar la sesión.');
  }

  if (['MOBILE_ASSIST_CONSENT_REQUESTED', 'MOBILE_ASSIST_PROCESSING'].includes(c.currentState) && !draft) {
    const section = tool('Comprobar la dirección y el partido judicial', 'Transcribe los datos contrastados con la ficha de Kmaleon y la demarcación judicial revisada.');
    const target = form(section);
    const fields = operatorFields(target);
    const address = {
      direccion: field(target, 'direccion', 'Dirección completa', { minLength: 5, maxLength: 250, value: c.direccion }),
      codigoPostal: field(target, 'codigoPostal', 'Código postal', { pattern: '[0-9]{5}', inputMode: 'numeric', maxLength: 5, value: c.codigoPostal }),
      provincia: field(target, 'provincia', 'Provincia', { minLength: 2, maxLength: 100, value: c.provincia }),
      localidad: field(target, 'localidad', 'Localidad', { minLength: 2, maxLength: 100, value: c.localidad }),
      comunidadAutonoma: field(target, 'comunidadAutonoma', 'Comunidad autónoma', { minLength: 2, maxLength: 100, value: c.comunidadAutonoma }),
      partidoJudicial: field(target, 'partidoJudicial', 'Partido judicial comprobado', { minLength: 2, maxLength: 100, value: c.partidoJudicial }),
    };
    const addressConfirmed = check(target, 'addressVerified', 'He contrastado la dirección y el partido judicial con la evidencia indicada.');
    if (capabilities.kmaleonAddressLookup === true) {
      const lookup = button(target, 'Consultar dirección en Kmaleon', 'button');
      const status = paragraph(target, 'La consulta rellena los datos; revisa la dirección antes de guardarla.');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      lookup.addEventListener('click', async () => {
        if (busy) return;
        try {
          assertCurrent();
          setBusy(true);
          status.textContent = 'Consultando la ficha del cliente en Kmaleon…';
          const result = await api(casePath + '/address-from-kmaleon', { method: 'POST', body: { version: c.version } });
          assertCurrent();
          const retrieved = result?.address;
          if (!retrieved || ['direccion', 'codigoPostal', 'provincia', 'localidad', 'evidenceRef'].some(key => typeof retrieved[key] !== 'string' || !retrieved[key].trim())) {
            throw new Error('Kmaleon no ha devuelto una dirección completa con evidencia verificable.');
          }
          const geography = result.geography;
          const knownName = item => typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '';
          const district = geography?.status === 'RESOLVED' ? knownName(geography.partidoJudicial) : '';
          address.direccion.value = retrieved.direccion;
          address.codigoPostal.value = retrieved.codigoPostal;
          address.provincia.value = knownName(geography?.provincia) || retrieved.provincia;
          address.localidad.value = retrieved.localidad;
          address.comunidadAutonoma.value = knownName(geography?.comunidadAutonoma) || (typeof retrieved.comunidadAutonoma === 'string' ? retrieved.comunidadAutonoma : '');
          address.partidoJudicial.value = district;
          fields.evidenceRef.value = retrieved.evidenceRef;
          addressConfirmed.checked = false;
          status.textContent = district
            ? 'Datos recuperados. Revisa la dirección y el partido judicial; todavía no se han guardado.'
            : 'Dirección recuperada. El partido judicial está pendiente de comprobación y se ha dejado vacío.';
        } catch (error) {
          const message = error instanceof Error ? error.message : 'No se pudo consultar la dirección.';
          status.textContent = message;
          notify(message);
        } finally { setBusy(false); }
      });
    }
    button(target, 'Guardar dirección comprobada');
    bind(target, '/address-evidence', () => ({ ...evidenceValues(fields), ...Object.fromEntries(Object.entries(address).map(([key, input]) => [key, input.value.trim()])) }), 'Dirección y procedencia registradas.');
  }

  if (c.currentState === 'MOBILE_ASSIST_PROCESSING' && !draft) {
    const section = tool('Preparar el borrador con el certificado', 'La sesión comprueba el certificado del cliente y prepara un borrador para su revisión.');
    const consentTime = new Date(c.consentGrantedAt).getTime();
    const freshConsent = c.consentGranted === true && Number.isFinite(consentTime) && consentTime > Date.now() - 3600000 && (!capabilities.consentVersion || c.consentVersion === capabilities.consentVersion);
    const addressReady = ['direccion', 'codigoPostal', 'localidad', 'provincia', 'comunidadAutonoma', 'partidoJudicial'].every(key => typeof c[key] === 'string' && c[key].trim()) && logs.some(log => log.event === 'OPERATOR_VERIFIED_ADDRESS');
    const available = capabilities.assistedCertificate === 'POST /api/cases/:id/assisted-draft' && capabilities.assistedDraftEnabled !== false;
    const missing = [];
    if (!c.identityVerified) missing.push('Identidad del cliente pendiente de comprobación.');
    if (!freshConsent) missing.push('Se necesita un consentimiento vigente, registrado durante la última hora.');
    if (!addressReady) missing.push('Falta guardar la dirección y su evidencia de comprobación.');
    if (!available) missing.push('La asistencia con la Sede todavía no está habilitada.');
    if (missing.length) {
      const list = document.createElement('ul');
      for (const message of missing) { const item = document.createElement('li'); item.textContent = message; list.append(item); }
      section.append(list);
    } else {
      paragraph(section, `Consentimiento registrado el ${dateText(c.consentGrantedAt)}. El certificado debe pertenecer a ${c.nombre}, ${c.dni}.`);
      const target = form(section);
      const certificate = field(target, 'certificate', 'Certificado del cliente (.pfx o .p12, máximo 1 MB)', { type: 'file', accept: '.pfx,.p12,application/x-pkcs12' });
      const password = field(target, 'certificatePassword', 'Contraseña del certificado', { type: 'password', autocomplete: 'new-password', maxLength: 1024 });
      check(target, 'scopedConsentConfirmed', 'La evidencia de consentimiento autoriza esta sesión de preparación del borrador.');
      const submit = button(target, 'Preparar borrador');
      const cancel = button(target, 'Interrumpir la sesión', 'button');
      cancel.hidden = true;
      const status = paragraph(target, 'Los campos del certificado y la contraseña se vacían al iniciar la sesión.');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      let controller = null;
      cancel.addEventListener('click', () => controller?.abort());
      target.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !target.reportValidity()) return;
        let bytes;
        let body;
        let file;
        const dialog = document.getElementById('case-dialog');
        const abort = () => controller?.abort();
        try {
          assertCurrent();
          file = certificate.files?.[0];
          bytes = new TextEncoder().encode(password.value);
          password.value = '';
          certificate.value = '';
          target.reset();
          if (!file || !/\.(pfx|p12)$/i.test(file.name) || file.size < 1 || file.size > 1024 * 1024) throw new Error('Selecciona un certificado .pfx o .p12 de hasta 1 MB.');
          if (bytes.byteLength > 1024) throw new Error('La contraseña supera el tamaño permitido.');
          body = new FormData();
          body.append('version', String(c.version));
          body.append('certificate', file, 'certificado.p12');
          body.append('password', new Blob([bytes], { type: 'application/octet-stream' }), 'password.bin');
          bytes.fill(0);
          file = null;
          controller = new AbortController();
          dialog?.addEventListener('close', abort);
          window.addEventListener('pagehide', abort);
          setBusy(true);
          cancel.hidden = false;
          cancel.disabled = false;
          submit.textContent = 'Preparando borrador…';
          status.textContent = 'La sesión está en curso. Puedes interrumpirla con el botón de abajo.';
          await api(`${casePath}/assisted-draft`, { method: 'POST', body, signal: controller.signal });
          await reload('Borrador preparado. Registra su revisión por el cliente.');
        } catch (error) {
          const message = error?.name === 'AbortError'
            ? 'Sesión interrumpida. Comprueba el estado del expediente antes de repetirla.'
            : (error instanceof Error ? error.message : 'No se pudo completar la sesión.');
          status.textContent = message;
          notify(message);
          if (selected?.id === c.id && dialog?.open) await openCase(c.id);
        } finally {
          bytes?.fill(0);
          body?.delete('certificate');
          body?.delete('password');
          file = null;
          controller = null;
          password.value = '';
          certificate.value = '';
          target.reset();
          dialog?.removeEventListener('close', abort);
          window.removeEventListener('pagehide', abort);
          cancel.hidden = true;
          submit.textContent = 'Preparar borrador';
          setBusy(false);
        }
      });
    }
  }

  if (c.currentState === 'MOBILE_ASSIST_PROCESSING' && draft) {
    if (!c.clientReviewed) {
      const section = tool('Registrar la revisión del borrador por el cliente', 'Comprueba la aceptación del cliente sobre este borrador concreto.');
      reference(section, draft);
      const target = form(section);
      const fields = operatorFields(target);
      const checked = check(target, 'clientReviewed', 'El cliente ha revisado y aceptado los datos de este borrador.');
      button(target, 'Registrar aceptación del borrador');
      bind(target, '/draft-review', () => ({ ...evidenceValues(fields), documentId: draft.id, sha256: draft.sha256Hash, clientReviewed: checked.checked }), 'Revisión del cliente registrada. La presentación requiere actuación humana.');
    } else {
      const section = tool('Registrar la presentación realizada en la Sede', 'Aporta el justificante de la presentación efectuada por una persona. Después se incorporará el apoderamiento final.');
      reference(section, draft);
      const target = form(section);
      const fields = operatorFields(target);
      const checked = check(target, 'submissionVerified', 'He comprobado el justificante de presentación efectiva de este borrador en la Sede.');
      button(target, 'Registrar justificante de presentación');
      bind(target, '/submission-confirmation', () => ({ ...evidenceValues(fields), documentId: draft.id, sha256: draft.sha256Hash, submissionVerified: checked.checked }), 'Presentación registrada. Carga el PDF final del apoderamiento para su revisión.');
    }
  }

  if (c.currentState === 'APUDATA_WAITING_PAYMENT') {
    const section = tool('Confirmar el pago comprobado al proveedor', 'Registra la comprobación del ingreso de 35,00 € vinculado a la admisión previa de este cliente.');
    const approval = c.apudataApprovalEvidence;
    const approved = c.apudataPreApproved === true && approval && typeof approval.id === 'string' && new Date(c.apudataApprovalExpiresAt).getTime() > Date.now();
    if (!approved) {
      paragraph(section, 'Falta una admisión previa vigente. Revisa la evidencia del proveedor antes de registrar el pago.', 'danger');
    } else {
      paragraph(section, `Admisión ${approval.id} · vigente hasta ${dateText(c.apudataApprovalExpiresAt)}.`);
      const target = form(section);
      const operatorId = field(target, 'operatorId', 'Nombre del gestor que comprueba el pago', { minLength: 3, maxLength: 100 });
      const paymentEvidenceRef = field(target, 'paymentEvidenceRef', 'Referencia del ingreso efectivamente comprobado', { minLength: 5, maxLength: 200 });
      const checked = check(target, 'paymentVerified', 'He comprobado el ingreso de 35,00 € y su correspondencia con este cliente y su admisión.');
      button(target, 'Registrar pago comprobado');
      bind(target, '/payment-confirmation', () => ({ operatorId: operatorId.value.trim(), approvalId: approval.id, paymentEvidenceRef: paymentEvidenceRef.value.trim(), amountCents: 3500, currency: 'EUR', paymentVerified: checked.checked }), 'Pago comprobado registrado. La solicitud continuará con su referencia verificada.');
    }
  }

  if (capabilities.documentRejection === true && c.currentState === 'AUDITING_DOCUMENT' && currentDocument && !currentDocument.uploadedKmaleon) {
    const section = tool('Solicitar la corrección del documento', 'Registra el defecto comprobado y la actuación que debe realizar el cliente.');
    const card = document.createElement('div');
    card.className = 'doc-card';
    const hash = document.createElement('code');
    hash.textContent = 'SHA-256 ' + currentDocument.sha256Hash;
    card.append(hash);
    section.append(card);
    const target = form(section);
    const operatorId = field(target, 'operatorId', 'Nombre del gestor que revisa el documento', { minLength: 3, maxLength: 100 });
    const reason = field(target, 'reason', 'Defecto observado y motivo de la corrección', { minLength: 10, maxLength: 300 });
    const label = document.createElement('label');
    label.append(document.createTextNode('Actuación indicada después de la revisión'));
    const disposition = document.createElement('select');
    disposition.name = 'disposition';
    disposition.required = true;
    for (const [value, text] of [['', 'Selecciona la actuación comprobada'], ['RESEND', 'Solicitar de nuevo el documento completo'], ['REVOKE_AND_REISSUE', 'Indicar al cliente que revoque y emita un nuevo poder']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.disabled = value === '';
      disposition.append(option);
    }
    disposition.value = '';
    label.append(disposition);
    target.append(label);
    check(target, 'correctionReviewed', 'He revisado el documento y esta es la actuación que procede comunicar al cliente.');
    button(target, 'Registrar solicitud de corrección');
    bind(target, '/documents/' + encodeURIComponent(currentDocument.id) + '/reject', () => ({
      sha256: currentDocument.sha256Hash, operatorId: operatorId.value.trim(), reason: reason.value.trim(), disposition: disposition.value,
    }), 'Corrección registrada con la referencia del documento revisado.');
  }

  if (c.currentState === 'ESCALATED_HUMAN') {
    const section = tool('Reanudar el expediente tras la revisión', 'La reanudación conserva el paso alcanzado y las evidencias. Las autorizaciones caducadas deben renovarse antes de utilizarlas.');
    const target = form(section);
    const reason = field(target, 'reason', 'Motivo de la reanudación y comprobación realizada', { minLength: 10, maxLength: 300 });
    check(target, 'recoveryReviewed', 'He revisado el motivo de la intervención y procede continuar desde el paso guardado.');
    button(target, 'Reanudar seguimiento');
    bind(target, '/recover', () => ({ reason: reason.value.trim() }), 'Expediente reanudado. Registra los hechos y autorizaciones vigentes.');
  }

  return root;
}
