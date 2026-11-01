import React from "react";
import { gpcEnabled, setAdOptOut, storedAdOptOut } from "../lib/consent";

// Footer control for the right to opt out of sale/sharing. The choice is stored on this device
// and can be undone; Global Privacy Control is always honored and cannot be undone here.
export default function AdChoices() {
  const [gpc] = React.useState(gpcEnabled);
  const [optedOut, setOptedOut] = React.useState(storedAdOptOut);
  const choose = (optOut: boolean) => { setAdOptOut(optOut); setOptedOut(optOut); };
  const link = "underline underline-offset-2 text-left md:text-right";
  if (gpc) return <span>Global Privacy Control detected: we do not sell or share your personal information from this browser.</span>;
  if (optedOut) return <span role="status">
    You opted out of the sale or sharing of your personal information on this device.{" "}
    <button type="button" className={link} onClick={() => choose(false)}>Undo</button>
  </span>;
  return <button type="button" className={link} onClick={() => choose(true)}>Do not sell or share my personal information</button>;
}
