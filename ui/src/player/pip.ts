// Picture in picture: the shell shrinks the window to a small always-on-top player in the corner
// of the screen and puts it back afterwards.

import { create } from 'zustand';
import { send } from '../bridge';

const usePipState = create<{ on: boolean }>(() => ({ on: false }));

export function usePip() {
  return usePipState((s) => s.on);
}

export function setPip(on: boolean) {
  if (usePipState.getState().on === on) return;
  usePipState.setState({ on });
  send({ t: 'pip', value: on });
}
