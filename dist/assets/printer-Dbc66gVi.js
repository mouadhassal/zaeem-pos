import{g as u}from"./index-D2xfRZ6r.js";import"./index-aM8QPgYu.js";const P=[{vendorId:"0x0416",productId:"0x5011",name:"Epson TM-T88V"},{vendorId:"0x0416",productId:"0x5020",name:"Epson TM-T88VI"},{vendorId:"0x1504",productId:"0x0006",name:"XPrinter XP-80"},{vendorId:"0x1504",productId:"0x0005",name:"XPrinter XP-58"},{vendorId:"0x1504",productId:"0x0008",name:"XPrinter XP-76"},{vendorId:"0x1fc9",productId:"0x2016",name:"GPrinter GP-80250"},{vendorId:"0x1fc9",productId:"0x2013",name:"GPrinter GP-5890"},{vendorId:"0x19f5",productId:"0x0101",name:"Bixolon SRP-350"},{vendorId:"0x19f5",productId:"0x0102",name:"Bixolon SRP-330"}];async function A(){const t=[];if(typeof navigator<"u"&&"usb"in navigator)try{const i=await navigator.usb.getDevices();for(const n of i){const e=n.vendorId.toString(16).padStart(4,"0"),o=n.productId.toString(16).padStart(4,"0"),s=`0x${e}`,r=P.find(d=>d.vendorId.toLowerCase()===s.toLowerCase());r&&t.push({id:crypto.randomUUID(),name:r.name,printerType:"RECEIPT",interface:"USB",vendorId:s,productId:`0x${o}`,port:0,paperWidthMm:80,codePage:"CP864",drawerPulseMs:200,isPrimary:t.length===0?1:0,isSecondary:0})}}catch{}return t}function w(t,i){const o=[],s={write:r=>{if(!r)return;const c=new TextEncoder().encode(r);for(const a of c)o.push(a)},writeCommand:(...r)=>{for(const d of r)o.push(d)},setBold:r=>{o.push(27,69,r?1:0)},setFontSize:(r,d)=>{o.push(29,33,r-1<<4|d-1)},setAlign:r=>{o.push(27,97,r)},setCodePage:r=>{const c={CP437:0,CP850:2,CP860:3,CP863:4,CP865:5,CP864:17,CP1256:19,CP1252:255}[r]??17;o.push(27,116,c)},cut:()=>{o.push(29,86,0)},openDrawer:r=>{const d=r<=100?0:r<=200?1:r<=300?2:3;o.push(27,112,d,25,50)},getBuffer:()=>new Uint8Array(o)};return s.writeCommand(27,64),s.setCodePage(t),s}function x(t,i){const n=i.paperWidthMm===58?32:48,e=w(i.codePage),o=t.currency??"SAR";e.setAlign(1),e.setFontSize(2,2),e.setBold(!0),e.write(t.chainName+`
`),e.setFontSize(1,1),e.setBold(!1),e.write(t.branchName+`
`),e.setAlign(0),e.write("=".repeat(n)+`
`),e.setAlign(1),e.write(`التاريخ: ${new Date().toLocaleDateString("ar-SA")}
`),e.write(`الوقت: ${new Date().toLocaleTimeString("ar-SA")}
`),e.write(`رقم الطلب: ${t.orderNumber}
`),e.write(`طاولة: ${t.tableName}
`);const s={DINE_IN:"داخلي",TAKEAWAY:"سفري",DELIVERY:"توصيل",ONLINE:"أونلاين"};e.write(`النوع: ${s[t.orderType]??t.orderType}
`),t.customerName&&e.write(`العميل: ${t.customerName}
`),t.deliveryAddress&&e.write(`العنوان: ${t.deliveryAddress}
`),e.setAlign(0),e.write("=".repeat(n)+`
`);const r=Math.floor((n-4)/2);e.setBold(!0),e.setFontSize(1,1);const d="الصنف".padEnd(r)+"الكمية".padEnd(6)+"السعر".padStart(r);e.write(d+`
`),e.setBold(!1),e.write("-".repeat(n)+`
`);for(const l of t.items){const p=l.name.slice(0,r-2),f=String(l.quantity),m=new Intl.NumberFormat("ar-SA",{style:"currency",currency:o}).format(l.priceCents*l.quantity/100);if(e.write(`${p} ${" ".repeat(r-p.length)}`),e.write(`${f}  ${m}
`),l.modifiers)for(const y of l.modifiers){const h=`  +${y.name}`,C=new Intl.NumberFormat("ar-SA",{style:"currency",currency:o}).format(y.priceCents/100);e.write(`${h}${" ".repeat(n-h.length-C.length)}${C}
`)}}e.write("-".repeat(n)+`
`);const c=l=>new Intl.NumberFormat("ar-SA",{style:"currency",currency:o}).format(l/100),a=(l,p,f)=>{const m=n-p.length-2;f&&e.setBold(!0),e.write(`${l}${" ".repeat(Math.max(0,m))}${p}
`),f&&e.setBold(!1)};return a("المجموع الفرعي",c(t.subtotalCents)),t.serviceChargeCents>0&&a("خدمة",c(t.serviceChargeCents)),a("الضريبة",c(t.taxCents)),t.secondaryTaxCents>0&&a("ضريبة إضافية",c(t.secondaryTaxCents)),t.discountCents>0&&a("الخصم",`-${c(t.discountCents)}`),t.savingsCents>0&&a("وفرتم",c(t.savingsCents),!0),e.write("=".repeat(n)+`
`),e.setFontSize(2,2),e.setBold(!0),a("الإجمالي",c(t.totalCents)),e.setFontSize(1,1),e.setBold(!1),e.write("=".repeat(n)+`
`),t.changeCents>0&&a("الباقي",c(t.changeCents)),e.setAlign(1),e.write(`
شكراً لزيارتكم
`),e.write(`نتمنى لكم يوماً سعيداً

`),e.openDrawer(200),e.getBuffer()}function _(t,i){const n=i.paperWidthMm===58?32:48,e=w(i.codePage);e.setAlign(1),e.setFontSize(2,2),e.setBold(!0),e.write(`*** المطبخ ***
`),e.setFontSize(1,1),e.setBold(!1),e.write("=".repeat(n)+`
`),e.setAlign(0);const o={DINE_IN:"داخلي",TAKEAWAY:"سفري",DELIVERY:"توصيل",ONLINE:"أونلاين"};e.write(`طاولة: ${t.tableName}
`),e.write(`رقم: ${t.orderNumber}
`),e.write(`النوع: ${o[t.orderType]??t.orderType}
`),e.write(`التاريخ: ${new Date().toLocaleDateString("ar-SA")}
`),e.write(`الوقت: ${new Date().toLocaleTimeString("ar-SA")}
`),t.scheduledAt&&(e.setBold(!0),e.write(`مجدول: ${new Date(t.scheduledAt).toLocaleTimeString("ar-SA")}
`),e.setBold(!1)),e.write("-".repeat(n)+`
`);for(const s of t.items){if(e.setFontSize(1,1),e.setBold(!0),e.write(`${s.quantity} × ${s.name}
`),e.setBold(!1),s.modifiers)for(const r of s.modifiers)e.write(`  + ${r}
`);s.notes&&e.write(`  ملاحظة: ${s.notes}
`),e.write(`
`)}e.write("-".repeat(n)+`
`),e.setAlign(1),e.write(`
`);for(let s=0;s<3;s++)e.write("\x07");return e.write(`
`),e.getBuffer()}async function g(t,i){if(i.interface==="USB"&&typeof navigator<"u"&&"usb"in navigator)try{const r=(await navigator.usb.getDevices()).find(d=>`0x${d.vendorId.toString(16).padStart(4,"0")}`===i.vendorId);if(!r)throw new Error("USB device not found");await r.open(),r.configuration===null&&await r.selectConfiguration(1),await r.claimInterface(0),await r.transferOut(1,t.buffer),await r.close();return}catch(s){const r=s instanceof Error?s.message:"USB print failed";throw new Error(r)}if(i.interface==="NETWORK"&&i.ipAddress)try{const s=await fetch(`http://${i.ipAddress}:${i.port}`,{method:"POST",body:t.buffer,headers:{"Content-Type":"application/octet-stream"}});if(!s.ok)throw new Error(`Network printer returned ${s.status}`);return}catch(s){const r=s instanceof Error?s.message:"Network printer error";throw new Error(r)}const n=new Blob([t.buffer],{type:"application/octet-stream"}),e=URL.createObjectURL(n),o=document.createElement("a");o.href=e,o.download=`print-${Date.now()}.bin`,o.click(),URL.revokeObjectURL(e)}async function S(t){const i=await u(),n=await i.selectFrom("printers").selectAll().where("printer_type","=","RECEIPT").where("is_active","=",1).orderBy("is_primary desc").orderBy("is_secondary desc").execute(),e=await i.selectFrom("chain_config").selectAll().where("id","=","default").executeTakeFirst(),o=(e==null?void 0:e.code_page)??"CP864",s=(e==null?void 0:e.default_paper_width)??80;let r=null;for(const d of n.slice(0,2)){const c=d;try{const a=x(t,{codePage:c.code_page??o,paperWidthMm:c.paper_width_mm??s});await g(a,{id:c.id,name:c.name,printerType:"RECEIPT",interface:c.interface,vendorId:c.vendor_id,ipAddress:c.ip_address,port:c.port,paperWidthMm:c.paper_width_mm,codePage:c.code_page,drawerPulseMs:c.drawer_pulse_ms,isPrimary:c.is_primary,isSecondary:c.is_secondary});return}catch(a){r=a instanceof Error?a.message:"Print failed"}}if(r){const d=new CustomEvent("print-failed",{detail:{receipt:t,error:r}});throw window.dispatchEvent(d),new Error("فشلت الطباعة")}}async function b(t){const i=await u(),n=await i.selectFrom("printers").selectAll().where("printer_type","=","KITCHEN").where("is_active","=",1).execute(),e=await i.selectFrom("chain_config").selectAll().where("id","=","default").executeTakeFirst(),o=(e==null?void 0:e.code_page)??"CP864",s=(e==null?void 0:e.default_paper_width)??80;let r=!1,d=null;if(n.length===0)throw window.dispatchEvent(new CustomEvent("kitchen-offline",{detail:t})),new Error("طابعة المطبخ غير متصلة");for(const c of n){const a=c;try{const l=_(t,{codePage:a.code_page??o,paperWidthMm:a.paper_width_mm??s});await g(l,{id:a.id,name:a.name,printerType:"KITCHEN",interface:a.interface,vendorId:a.vendor_id,ipAddress:a.ip_address,port:a.port,paperWidthMm:a.paper_width_mm,codePage:a.code_page,drawerPulseMs:a.drawer_pulse_ms,isPrimary:a.is_primary,isSecondary:a.is_secondary}),r=!0}catch(l){d=l instanceof Error?l.message:"Kitchen print failed"}}if(!r)throw window.dispatchEvent(new CustomEvent("kitchen-offline",{detail:t})),new Error(d??"فشلت طباعة المطبخ")}async function T(t=200){const n=await(await u()).selectFrom("printers").selectAll().where("printer_type","=","RECEIPT").where("is_primary","=",1).where("is_active","=",1).executeTakeFirst();if(!n)return;const e=n,o=w(e.code_page??"CP864",e.paper_width_mm??80);o.openDrawer(t??e.drawer_pulse_ms??200);const s=o.getBuffer();await g(s,{id:e.id,name:e.name,printerType:"RECEIPT",interface:e.interface,vendorId:e.vendor_id,ipAddress:e.ip_address,port:e.port,paperWidthMm:e.paper_width_mm,codePage:e.code_page,drawerPulseMs:e.drawer_pulse_ms,isPrimary:e.is_primary,isSecondary:e.is_secondary})}function N(t){const i=t.currency??"SAR",n=o=>new Intl.NumberFormat("ar-SA",{style:"currency",currency:i}).format(o/100);let e="";for(const o of t.items)if(e+=`<tr><td>${o.quantity}× ${o.name}</td><td style="text-align:left">${n(o.priceCents*o.quantity)}</td></tr>`,o.modifiers)for(const s of o.modifiers)e+=`<tr style="color:#999"><td style="padding-right:16px">+ ${s.name}</td><td style="text-align:left">${n(s.priceCents)}</td></tr>`;return`
    <div dir="rtl" style="font-family:'Arabic Typesetting',Arial,sans-serif;padding:24px;max-width:320px;margin:0 auto;direction:rtl">
      <h2 style="text-align:center;margin:0">${t.chainName}</h2>
      <p style="text-align:center;color:#666;margin:4px 0">${t.branchName}</p>
      <hr/>
      <table style="width:100%;font-size:14px">
        <tr><td>التاريخ</td><td style="text-align:left">${new Date().toLocaleDateString("ar-SA")}</td></tr>
        <tr><td>الوقت</td><td style="text-align:left">${new Date().toLocaleTimeString("ar-SA")}</td></tr>
        <tr><td>رقم الطلب</td><td style="text-align:left">${t.orderNumber}</td></tr>
        <tr><td>طاولة</td><td style="text-align:left">${t.tableName}</td></tr>
      </table>
      <hr/>
      <table style="width:100%;font-size:14px">
        <thead><tr style="font-weight:bold"><th style="text-align:right">الصنف</th><th style="text-align:left">السعر</th></tr></thead>
        <tbody>${e}</tbody>
      </table>
      <hr/>
      <table style="width:100%;font-size:14px">
        <tr><td>المجموع الفرعي</td><td style="text-align:left">${n(t.subtotalCents)}</td></tr>
        <tr><td>الضريبة</td><td style="text-align:left">${n(t.taxCents)}</td></tr>
        ${t.discountCents>0?`<tr><td>الخصم</td><td style="text-align:left;color:red">-${n(t.discountCents)}</td></tr>`:""}
        <tr style="font-weight:bold;font-size:18px"><td>الإجمالي</td><td style="text-align:left">${n(t.totalCents)}</td></tr>
      </table>
      <hr/>
      <p style="text-align:center;font-size:16px">شكراً لزيارتكم</p>
    </div>
  `}async function B(){const i=await(await u()).selectFrom("chain_config").select(["chain_name","currency"]).where("id","=","default").executeTakeFirst();await S({chainName:(i==null?void 0:i.chain_name)??"مطعم التجربة",branchName:"الفرع الرئيسي",currency:(i==null?void 0:i.currency)??"SAR",orderNumber:"TEST-001",tableName:"طاولة 1",orderType:"DINE_IN",items:[{name:"برجر",quantity:1,priceCents:2500}],subtotalCents:2500,taxCents:375,secondaryTaxCents:0,serviceChargeCents:0,discountCents:0,savingsCents:0,totalCents:2875,paymentMethod:"CASH",changeCents:125})}function D(t,i){const n=JSON.parse(localStorage.getItem("printQueue")??"[]");n.push({data:t,type:i,timestamp:Date.now()}),localStorage.setItem("printQueue",JSON.stringify(n))}function E(){return JSON.parse(localStorage.getItem("printQueue")??"[]")}function v(){localStorage.removeItem("printQueue")}async function F(){const t=E();if(t.length===0)return;const i=[];for(const n of t)try{n.type==="receipt"?await S(n.data):await b(n.data)}catch{i.push(n)}i.length>0?localStorage.setItem("printQueue",JSON.stringify(i)):v()}export{v as clearPrintQueue,w as createEscPosBuffer,A as discoverPrinters,N as generateOnScreenReceiptHTML,E as getPrintQueue,T as openCashDrawer,b as printKitchenTicket,S as printReceipt,g as printToDevice,D as queuePrintJob,F as retryPrintQueue,B as testPrint};
