export const DEFAULT_SETTINGS = {
  rounds: 3,
  restSec: 60,
  switchSec: 10,
  countdownSec: 5,
  audioOn: true,
  voiceOn: true,
  volume: 0.8,
  lastExportAt: null,
};

export const SEED_EXERCISES = [
  {
    id: "ex_wall_sit",
    name: "Wall sit",
    cues: ["Back flat on the wall", "Thighs parallel to the floor", "Knees over ankles"],
    mode: "max",
    targetSec: 30,
    unilateral: false,
    incrementSec: 5,
    enabled: true,
    order: 0,
    archived: false,
  },
  {
    id: "ex_split_squat",
    name: "Split squat iso",
    cues: ["Front shin vertical", "Back knee points down", "Torso tall"],
    mode: "target",
    targetSec: 30,
    unilateral: true,
    incrementSec: 5,
    enabled: true,
    order: 1,
    archived: false,
  },
  {
    id: "ex_dead_hang",
    name: "Dead hang",
    cues: ["Shoulders away from ears", "Arms straight", "Grip just outside shoulders"],
    mode: "max",
    targetSec: 20,
    unilateral: false,
    incrementSec: 5,
    enabled: true,
    order: 2,
    archived: false,
  },
  {
    id: "ex_plank_leg",
    name: "Plank, one leg lifted",
    cues: ["Hips level", "Ribs down", "Lifted leg straight"],
    mode: "target",
    targetSec: 20,
    unilateral: true,
    incrementSec: 5,
    enabled: true,
    order: 3,
    archived: false,
  },
  {
    id: "ex_pike",
    name: "Pike push-up hold",
    cues: ["Hips high", "Head between the hands", "Elbows tucked"],
    mode: "target",
    targetSec: 15,
    unilateral: false,
    incrementSec: 5,
    enabled: true,
    order: 4,
    archived: false,
  },
  {
    id: "ex_towel_row",
    name: "Towel row iso",
    cues: ["Body in one line", "Elbows pull to the ribs", "Squeeze the shoulder blades"],
    mode: "max",
    targetSec: 20,
    unilateral: false,
    incrementSec: 5,
    enabled: true,
    order: 5,
    archived: false,
  },
];

export function activeExercises(exercises) {
  return exercises
    .filter((ex) => ex.enabled && !ex.archived)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** One step per hold, plus a switch step between left and right. Rest is a phase, not a step. */
export function buildSteps(exercises, rounds) {
  const list = activeExercises(exercises);
  const steps = [];
  const totalRounds = Math.max(1, rounds | 0);
  for (let round = 1; round <= totalRounds; round++) {
    for (const ex of list) {
      const sides = ex.unilateral ? ["L", "R"] : [null];
      for (const side of sides) {
        if (side === "R") {
          steps.push({
            kind: "switch",
            round,
            exerciseId: ex.id,
            name: ex.name,
            toSide: "R",
          });
        }
        steps.push({
          kind: "hold",
          round,
          exerciseId: ex.id,
          name: ex.name,
          cues: (ex.cues || []).slice(0, 3),
          mode: ex.mode === "max" ? "max" : "target",
          targetSec: Number(ex.targetSec) || 0,
          side,
          unilateral: !!ex.unilateral,
          incrementSec: Number(ex.incrementSec) || 5,
        });
      }
    }
  }
  return steps;
}

export function newExercise(partial, order) {
  return {
    id: partial.id,
    name: partial.name.trim(),
    cues: (partial.cues || []).map((c) => c.trim()).filter(Boolean).slice(0, 3),
    mode: partial.mode === "max" ? "max" : "target",
    targetSec: Math.max(1, Math.round(Number(partial.targetSec) || 20)),
    unilateral: !!partial.unilateral,
    incrementSec: Math.max(1, Math.round(Number(partial.incrementSec) || 5)),
    enabled: partial.enabled !== false,
    order,
    archived: false,
  };
}
