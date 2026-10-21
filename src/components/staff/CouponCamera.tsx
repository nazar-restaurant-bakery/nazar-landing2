import {useEffect,useRef,useState} from 'react';
import {couponFromQr} from '../../lib/couponCheckout';

export default function CouponCamera({onCode,onClose}:{onCode:(code:string)=>void;onClose:()=>void}) {
  const video=useRef<HTMLVideoElement>(null);
  const [message,setMessage]=useState('Kamera izni bekleniyor. Kod yazarak da devam edebilirsiniz.');
  useEffect(()=>{
    let active=true,stream:MediaStream|null=null,timer:ReturnType<typeof setTimeout>|undefined;
    const canvas=document.createElement('canvas');
    const stop=()=>{active=false;clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());if(video.current)video.current.srcObject=null;};
    async function open(){
      try{
        if(!navigator.mediaDevices?.getUserMedia)throw Error();
        stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
        if(!active){stream.getTracks().forEach(track=>track.stop());return;}
        if(!video.current)throw Error();
        video.current.srcObject=stream;await video.current.play();
        const {default:decode}=await import('jsqr');
        if(!active)return;
        setMessage('QR’ı kameraya gösterin. Görüntü bu cihazda işlenir.');
        const tick=()=>{
          if(!active)return;
          try{
            const v=video.current;
            if(v&&v.readyState>=2&&v.videoWidth){
              canvas.width=Math.min(v.videoWidth,640);canvas.height=Math.round(v.videoHeight*canvas.width/v.videoWidth);
              const ctx=canvas.getContext('2d',{willReadFrequently:true});
              if(ctx){ctx.drawImage(v,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
                const found=decode(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'});
                if(found){const code=couponFromQr(found.data);if(code){stop();onCode(code);return;}
                  setMessage('Bu QR bir VIP kuponu değil. Kupon QR’ını okutun veya kodu yazın.');}
              }
            }
          }catch{stop();setMessage('Kamera okunamadı. Kupon kodunu yazarak devam edin.');return;}
          timer=setTimeout(tick,250);
        };tick();
      }catch{stop();setMessage('Kamera açılamadı veya izin verilmedi. Kupon kodunu yazarak devam edin.');}
    }
    void open();return stop;
  },[onCode]);
  return <section className="staff-panel p-3" aria-label="Kupon kamerası">
    <video ref={video} autoPlay muted playsInline className="w-full max-w-md rounded-lg" aria-label="QR kamera görüntüsü" />
    <p role="status" className="mt-2 mb-2 text-sm">{message}</p>
    <button type="button" className="staff-button staff-secondary" onClick={onClose}>Kamerayı kapat</button>
  </section>;
}
