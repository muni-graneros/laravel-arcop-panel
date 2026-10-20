import PDFDocument from 'pdfkit';
import { randomBytes,randomUUID,sign,verify,createPublicKey } from 'node:crypto';
import { sha256 } from './domain.js';
export async function securityReport({client,domains,findings,integrity,privateKey,keyId='deployment-key'}) {
  const id=randomUUID(),code='GA-SE-'+randomBytes(4).toString('hex').toUpperCase();
  const doc=new PDFDocument({size:'A4',margin:48,info:{Title:'Gen-Auditor · Seguridad externa',Author:'Gen-Auditor'}}),chunks=[];
  const complete=new Promise((resolve,reject)=>{doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const text=(s,size=10)=>doc.font('Helvetica').fontSize(size).fillColor('#334155').text(String(s));
  doc.fontSize(23).fillColor('#0f172a').text('Gen-Auditor');text('Informe ejecutivo de seguridad externa',16);text(code);doc.moveDown();
  text('Cliente: '+client.name);text('Emitido: '+new Date().toISOString());text('Integridad de cadena: '+(integrity?'verificada localmente':'no verificada'));doc.moveDown();
  text('Resumen ejecutivo',15);text(`${domains.length} dominios registrados; ${findings.length} hallazgos abiertos. Evaluacion acotada a las comprobaciones ejecutadas. Un dominio sin prueba completada no se considera seguro.`);
  text('Nivel de exposicion e impacto potencial',15);text(findings.length?'Exposicion observada: revisar hallazgos y contexto. Las cabeceras ausentes indican oportunidades de endurecimiento; no prueban por si solas una explotacion.':'No se observan hallazgos abiertos en el alcance registrado; no equivale a ausencia de vulnerabilidades.');doc.moveDown();
  text('Matriz de remediacion priorizada',15);
  const order={critical:0,high:1,medium:2,low:3,info:4};
  for(const f of [...findings].sort((a,b)=>order[a.severity]-order[b.severity])){
    if(doc.y>660)doc.addPage();doc.moveDown();text(f.severity.toUpperCase()+' · '+f.title,12);text('Vencimiento interno: '+(f.due_at?new Date(f.due_at).toISOString():'sin SLA'));text(f.recommendation);
    if(f.code_example)doc.font('Courier').fontSize(8).text(f.code_example,{width:480});
  }
  doc.moveDown();text('Marco y limites',15);text('Apoyo a la gestion de vulnerabilidades ISO/IEC 27001:2022 A.8.8 (referencia historica 2013 A.12.6.1) y evidencias para deberes de ciberseguridad aplicables. No certifica cumplimiento ni sustituye revision de aplicabilidad. Los SLA de 48h/7d/15d/30d son politicas internas.');
  text('El codigo '+code+' es un identificador. El hash completo y la firma tecnica estan en el manifiesto separado. La firma Ed25519 no es firma electronica avanzada acreditada.');
  doc.end();const pdf=await complete;
  const manifest={version:1,id,code,client_id:client.id,tenant_id:client.tenant_id,sha256:sha256(pdf),created_at:new Date().toISOString(),key_id:keyId,algorithm:'Ed25519'};
  const canonical=JSON.stringify(manifest),signature=sign(null,Buffer.from(canonical),privateKey).toString('base64');
  return {id,code,pdf,manifest:{...manifest,canonical,public_key:createPublicKey(privateKey).export({type:'spki',format:'pem'})},signature};
}
export function verifyReport(pdf,manifest,signature,publicKey) {
  const parsed=JSON.parse(manifest.canonical);
  return parsed.sha256===sha256(pdf)&&verify(null,Buffer.from(manifest.canonical),publicKey,Buffer.from(signature,'base64'));
}
