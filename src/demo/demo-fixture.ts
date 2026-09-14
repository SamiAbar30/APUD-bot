export const DEMO_PHONE_NUMBER='34663094035';
export const DEMO_FIXTURE_SOURCE='DEMO_FIXTURE' as const;

export interface DemoFixture {
  source: typeof DEMO_FIXTURE_SOURCE;
  dni: '12345678Z';
  nombre: 'DEMO APOD CLIENT';
  telefono: string;
  kmaleonExpedienteId: string;
}

export function demoFixture(phone: string): DemoFixture {
  const telefono=phone.trim();
  if(!/^\d{5,20}$/.test(telefono))throw new Error('DEMO_PHONE_INVALID');
  return {source:DEMO_FIXTURE_SOURCE,dni:'12345678Z',nombre:'DEMO APOD CLIENT',telefono,kmaleonExpedienteId:`demo-kmaleon-${telefono}`};
}
