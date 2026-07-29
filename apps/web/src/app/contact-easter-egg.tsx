"use client";

import { ArrowRight, BadgeCheck, CircleHelp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { requestFinkleKick } from "../lib/finkle-kick";
import styles from "./landing.module.css";

export function ContactEasterEgg() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const revealCloseRef = useRef<HTMLButtonElement>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (revealed) revealCloseRef.current?.focus();
  }, [revealed]);

  function openDialog() {
    setRevealed(false);
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function chooseFinkle() {
    closeDialog();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(requestFinkleKick);
    });
  }

  return (
    <>
      <button className={styles.footerContact} type="button" onClick={openDialog}>
        Contact
      </button>
      <dialog
        className={styles.contactDialog}
        ref={dialogRef}
        aria-labelledby="contact-easter-egg-title"
        aria-describedby="contact-easter-egg-description"
        onClose={() => setRevealed(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <div className={styles.contactDialogPanel}>
          <button
            className={styles.contactDialogClose}
            type="button"
            aria-label="Close contact dialog"
            onClick={closeDialog}
          >
            <X size={17} aria-hidden="true" />
          </button>

          <p className={styles.contactDialogCase}>Case file 13</p>
          {revealed ? (
            <div className={styles.contactDialogReveal}>
              <span className={styles.contactDialogIcon}>
                <BadgeCheck size={22} aria-hidden="true" />
              </span>
              <p className={styles.contactDialogEyebrow}>Identity confirmed</p>
              <h2 id="contact-easter-egg-title">Finkle is Einhorn!</h2>
              <p id="contact-easter-egg-description">Einhorn is Finkle. The laces were in.</p>
              <button
                className={styles.contactDialogPrimary}
                ref={revealCloseRef}
                type="button"
                onClick={closeDialog}
              >
                All righty then <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div>
              <span className={styles.contactDialogIcon}>
                <CircleHelp size={22} aria-hidden="true" />
              </span>
              <p className={styles.contactDialogEyebrow}>Personnel directory</p>
              <h2 id="contact-easter-egg-title">Contact who?</h2>
              <p id="contact-easter-egg-description">Finkle or Einhorn?</p>
              <div className={styles.contactDialogChoices}>
                <button type="button" onClick={chooseFinkle}>
                  Finkle
                </button>
                <button type="button" onClick={() => setRevealed(true)}>
                  Einhorn
                </button>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
