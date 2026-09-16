'use strict';
function renderInboxActions(rows){
  document.querySelectorAll('.open-inbox-case').forEach(button=>button.onclick=()=>openCase(button.dataset.id));
  document.querySelectorAll('.link-inbox').forEach(button=>button.onclick=()=>{
    const row=rows.find(item=>item.id===button.dataset.id);if(!row)return;
    const candidates=cases.filter(c=>c.telefono===row.telefono&&c.identityVerified);
    selected=null;
    $('case-detail').innerHTML=`<h2>Vincular entrada</h2><p>${escapeHtml(row.telefono)}</p>${candidates.length?`<form id="link-inbox-form" class="form-grid"><label>Expediente con el mismo teléfono<select name="expedienteId">${candidates.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.nombre)} · ${escapeHtml(c.dni)}</option>`).join('')}</select></label><label class="check"><input type="checkbox" required> He comprobado la identidad y el origen del mensaje.</label><button class="primary">Vincular y procesar</button></form>`:'<p>No hay un expediente local con este teléfono. Busca el cliente en Kmaleon, añádelo y APOD vinculará después esta entrada.</p><button id="search-kmaleon-for-inbox" class="primary">Buscar y añadir en Kmaleon</button>'}`;
    $('case-dialog').showModal();const form=$('link-inbox-form');if(form)form.onsubmit=async e=>{e.preventDefault();try{const f=new FormData(form);await api(`/api/inbox/${row.id}/link`,{method:'POST',body:{expedienteId:f.get('expedienteId'),identityVerified:true}});$('case-dialog').close();notify('Entrada vinculada y pendiente de procesamiento');await refresh()}catch(error){notify(error.message)}};const searchButton=$('search-kmaleon-for-inbox');if(searchButton)searchButton.onclick=()=>openKmaleonSearch(async c=>{await api(`/api/inbox/${row.id}/link`,{method:'POST',body:{expedienteId:c.id,identityVerified:true}});notify('Expediente añadido y entrada vinculada');await refresh()});
  });
  document.querySelectorAll('.review-inbox').forEach(button=>button.onclick=()=>{
    const row=rows.find(item=>item.id===button.dataset.id);if(!row)return;selected=null;
    $('case-detail').innerHTML=`<h2>Registrar atención de la entrada</h2><p>Confirma la gestión que has realizado. Esta anotación cierra la entrada de la bandeja; el estado del expediente sigue su propio proceso.</p><form id="review-inbox-form" class="form-grid"><label>Gestor<input name="operatorId" minlength="3" maxlength="100" required></label><label>Evidencia de la gestión realizada<input name="evidenceRef" minlength="5" maxlength="200" required></label><label class="check"><input type="checkbox" required> He atendido esta entrada en el canal autorizado y registrado las actuaciones necesarias.</label><button class="primary">Registrar atención</button></form>`;
    $('case-dialog').showModal();$('review-inbox-form').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);await api(`/api/inbox/${row.id}/review`,{method:'POST',body:{operatorId:f.get('operatorId'),evidenceRef:f.get('evidenceRef'),handledInPerson:true}});$('case-dialog').close();notify('Atención registrada');await refresh()}catch(error){notify(error.message)}};
  });
}
