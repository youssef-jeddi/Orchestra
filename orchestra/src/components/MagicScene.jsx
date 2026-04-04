'use client';

import { useRef, useEffect, useState, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Sparkles, Float } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { motion, useScroll, useTransform } from 'framer-motion';

// ─── Models ───────────────────────────────────────────────────────

function MaestroModel() {
  const { scene } = useGLTF('/models/maestro.glb');
  return (
    <Float speed={1.5} floatIntensity={0.3} rotationIntensity={0.1}>
      <primitive
        object={scene}
        scale={[1.5, 1.5, 1.5]}
        position={[0, -1.5, 0]}
        rotation={[0, 0, 0]}
      />
    </Float>
  );
}

function WandModel() {
  const { scene } = useGLTF('/models/wand.glb');
  const groupRef = useRef();

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.z = Math.sin(clock.elapsedTime * 1.5) * 0.15;
    }
  });

  return (
    <group ref={groupRef} position={[0.5, -0.5, 0.4]}>
      <primitive object={scene} scale={1.2} rotation={[0.2, 0.1, -0.4]} />
    </group>
  );
}

// ─── Spotlight rig ────────────────────────────────────────────────

function SpotlightRig() {
  const spotRef = useRef();
  useEffect(() => {
    if (spotRef.current) {
      spotRef.current.target.position.set(0, -1.5, 0);
      spotRef.current.target.updateMatrixWorld();
    }
  }, []);
  return (
    <spotLight
      ref={spotRef}
      position={[0, 6, 4]}
      angle={0.4}
      penumbra={0.8}
      intensity={2.5}
      color="#FFB347"
      castShadow
    />
  );
}

// ─── Stage décor ──────────────────────────────────────────────────

function StageDecor() {
  return (
    <>
      <mesh position={[0, -1.575, 0]} receiveShadow>
        <cylinderGeometry args={[3, 3, 0.15, 64]} />
        <meshStandardMaterial color="#2A1810" roughness={0.8} metalness={0.1} />
      </mesh>
      <mesh position={[0, 2, -4]}>
        <planeGeometry args={[12, 8]} />
        <meshStandardMaterial color="#0D0D0D" roughness={1} />
      </mesh>
    </>
  );
}

// ─── Camera rig — mouse parallax + slow auto-rotation ─────────────

function CameraRig({ mouseRef }) {
  const angleRef = useRef(0);

  useFrame(({ camera }) => {
    angleRef.current += 0.0008;

    const tx = Math.sin(angleRef.current) * 0.4 + mouseRef.current.x * 0.3;
    const ty = 1.5 + mouseRef.current.y * 0.2;

    camera.position.x += (tx - camera.position.x) * 0.03;
    camera.position.y += (ty - camera.position.y) * 0.03;
    camera.lookAt(0, -0.5, 0);
  });

  return null;
}

// ─── Scene content ────────────────────────────────────────────────

function SceneContent({ mouseRef }) {
  return (
    <>
      <ambientLight color="#1a1a2e" intensity={0.15} />
      <SpotlightRig />
      <pointLight position={[-3, 3, 2]} intensity={0.8} color="#C084FC" />
      <pointLight position={[3, 2, 1]} intensity={0.4} color="#FFD700" />

      <StageDecor />

      <Suspense fallback={null}>
        <MaestroModel />
        <WandModel />
      </Suspense>

      <Sparkles count={200} size={3} scale={[5, 5, 5]} speed={0.5} color="#FFD700" />
      <Sparkles count={100} size={2} scale={[4, 4, 4]} speed={0.3} color="#C084FC" />
      <Sparkles count={60} size={1.5} scale={[8, 8, 8]} speed={0.2} color="#FFFFFF" opacity={0.4} />

      <CameraRig mouseRef={mouseRef} />

      <Suspense fallback={null}>
        <EffectComposer>
          <Bloom luminanceThreshold={0.6} intensity={0.8} mipmapBlur />
        </EffectComposer>
      </Suspense>
    </>
  );
}

// ─── MagicScene ───────────────────────────────────────────────────

export default function MagicScene() {
  const [mounted, setMounted] = useState(false);
  const mouseRef = useRef({ x: 0, y: 0 });

  const { scrollYProgress } = useScroll();
  const opacity = useTransform(scrollYProgress, [0.12, 0.22], [1, 0]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    useGLTF.preload('/models/maestro.glb');
    useGLTF.preload('/models/wand.glb');

    const onMove = (e) => {
      mouseRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseRef.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  if (!mounted) return null;

  return (
    <motion.div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        opacity,
      }}
    >
      <Canvas
        camera={{ position: [0, 1.5, 6], fov: 45 }}
        gl={{ antialias: true }}
        shadows
        style={{ background: '#0F0F12', width: '100%', height: '100%' }}
      >
        <SceneContent mouseRef={mouseRef} />
      </Canvas>
    </motion.div>
  );
}
