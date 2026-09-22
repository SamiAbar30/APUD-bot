export const DEMO_PHONE_NUMBER='34600000000';
export const DEMO_FIXTURE_SOURCE='DEMO_FIXTURE' as const;

export interface DemoFixture {
  source: typeof DEMO_FIXTURE_SOURCE;
  dni: '12345678Z';
  nombre: 'DEMO APOD CLIENT';
  telefono: string;
  empresa: 'MYKREDIT';
  numeroExpediente: '24531';
  kmaleonExpedienteId: string;
}

export function demoFixture(phone: string): DemoFixture {
  const telefono=phone.trim();
  if(!/^\d{5,20}$/.test(telefono))throw new Error('DEMO_PHONE_INVALID');
  return {source:DEMO_FIXTURE_SOURCE,dni:'12345678Z',nombre:'DEMO APOD CLIENT',telefono,empresa:'MYKREDIT',numeroExpediente:'24531',kmaleonExpedienteId:`demo-kmaleon-${telefono}`};
}
