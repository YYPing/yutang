import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AUDIO_TRACKS,AmbientMixer,ambientDescription} from '../audio/ambient.js';
// ★ dayLight（0..1 连续昼夜标量）取代布尔 night（2026-10-04）；
//   ambientMix 两种都接受，这里传连续值 ⇒ 黎明时声音渐强而不是突然变大。
export function useAmbient(enabled,volume,weather,season,dayLight,theme='koi'){
 const media=useRef({}),mixer=useRef(null);const [status,setStatus]=useState('off');
 const tracks=useMemo(()=>AUDIO_TRACKS.map(track=>({...track,url:`${import.meta.env.BASE_URL}assets/${track.file}`,ref:node=>{if(node)media.current[track.id]=node;else delete media.current[track.id]}})),[]);
 useEffect(()=>{const instance=new AmbientMixer({...media.current},setStatus);mixer.current=instance;return()=>{instance.destroy();mixer.current=null}},[]);
 useEffect(()=>{mixer.current?.configure({enabled,volume,weather,season,night:dayLight,theme})},[enabled,volume,weather,season,dayLight,theme]);
 const thunder=useCallback(event=>mixer.current?.thunder(event),[]);
 return {tracks,status,thunder,description:ambientDescription(weather,season,theme)};
}
