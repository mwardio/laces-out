"use client";

import type { AiProviderName } from "@laces-out/contracts";
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { AI_PROVIDER_META } from "../lib/ai-provider-meta";
import styles from "./ai-provider-picker.module.css";

export interface AiProviderPickerOption {
  readonly provider: AiProviderName;
  readonly detail: string;
  readonly state?: "ready" | "invalid" | "idle";
}

export interface AiProviderPickerProps {
  readonly options: readonly AiProviderPickerOption[];
  readonly value: AiProviderName;
  readonly onChange: (provider: AiProviderName) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export function AiProviderPicker({
  options,
  value,
  onChange,
  label = "AI provider",
  disabled = false,
}: AiProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.provider === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedOption = pickerRef.current?.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    );
    selectedOption?.focus();
  }, [open]);

  if (!selected) return null;

  const selectedMeta = AI_PROVIDER_META[selected.provider];

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    );
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;

    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
      return;
    }
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % buttons.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = buttons.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }

  return (
    <div
      className={`${styles.picker}${open ? ` ${styles.pickerOpen}` : ""}`}
      ref={pickerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${styles[selected.provider]}`}
        aria-label={`${label}: ${selectedMeta.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className={styles.mark}>{selectedMeta.shortName}</span>
        <span className={styles.copy}>
          <small>{label}</small>
          <strong>{selectedMeta.name}</strong>
          <span>{selected.detail}</span>
        </span>
        <span
          className={`${styles.statusDot} ${
            selected.state === "ready"
              ? styles.statusReady
              : selected.state === "invalid"
                ? styles.statusInvalid
                : ""
          }`}
          aria-hidden="true"
        />
        <ChevronDown
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ""}`}
          size={17}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <>
          <button
            className={styles.mobileBackdrop}
            type="button"
            aria-label="Close provider menu"
            onClick={closeAndFocusTrigger}
          />
          <div
            className={styles.menu}
            id={listboxId}
            role="listbox"
            aria-label={label}
            onKeyDown={handleListKeyDown}
          >
            <div className={styles.menuHeading}>
              <span>Choose provider</span>
            </div>
            {options.map((option) => {
              const meta = AI_PROVIDER_META[option.provider];
              const isSelected = option.provider === value;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`${styles.option} ${styles[option.provider]}`}
                  key={option.provider}
                  onClick={() => {
                    onChange(option.provider);
                    closeAndFocusTrigger();
                  }}
                >
                  <span className={styles.mark}>{meta.shortName}</span>
                  <span className={styles.optionCopy}>
                    <strong>{meta.name}</strong>
                    <small>{option.detail}</small>
                  </span>
                  <span
                    className={`${styles.statusDot} ${
                      option.state === "ready"
                        ? styles.statusReady
                        : option.state === "invalid"
                          ? styles.statusInvalid
                          : ""
                    }`}
                    aria-hidden="true"
                  />
                  <Check
                    className={`${styles.check}${isSelected ? ` ${styles.checkVisible}` : ""}`}
                    size={16}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
