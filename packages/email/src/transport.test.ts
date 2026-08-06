import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  return {
    sendMail: sendMailMock,
    createTransport: vi.fn(() => ({ sendMail: sendMailMock })),
  };
});

vi.mock("nodemailer", () => ({ createTransport }));

import { createSmtpEmailTransport } from "./transport.js";

const configuration = {
  host: "smtp.mail.me.com",
  port: 587,
  user: "operator@icloud.com",
  password: "app-specific-password",
  from: "Laces Out <noreply@lacesout.app>",
};

const message = {
  to: "member@example.com",
  subject: "Welcome to Laces Out",
  text: "hello",
  html: "<p>hello</p>",
};

beforeEach(() => {
  sendMail.mockReset();
  createTransport.mockClear();
});

describe("createSmtpEmailTransport", () => {
  it("requires TLS and uses implicit TLS only on port 465", () => {
    createSmtpEmailTransport(configuration);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true }),
    );
    createSmtpEmailTransport({ ...configuration, port: 465 });
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: true }));
  });

  it("sends with the configured From identity", async () => {
    sendMail.mockResolvedValue({});
    const transport = createSmtpEmailTransport(configuration);
    await expect(transport.send(message)).resolves.toBe("sent");
    expect(sendMail).toHaveBeenCalledWith({
      from: configuration.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it("maps any transport error to a failed outcome with a sanitized code", async () => {
    const failure = Object.assign(new Error("550 recipient <member@example.com> rejected"), {
      responseCode: 550,
    });
    sendMail.mockRejectedValue(failure);
    const observed: unknown[] = [];
    const transport = createSmtpEmailTransport(configuration, (event) => observed.push(event));
    await expect(transport.send(message)).resolves.toBe("failed");
    // The observer gets a code, never the error text that can echo the recipient.
    expect(observed).toEqual([{ event: "send-failed", code: "550" }]);
  });

  it("reports unknown when the error carries no usable code", async () => {
    sendMail.mockRejectedValue(new Error("boom"));
    const observed: { code: string }[] = [];
    const transport = createSmtpEmailTransport(configuration, (event) => observed.push(event));
    await expect(transport.send(message)).resolves.toBe("failed");
    expect(observed[0]?.code).toBe("unknown");
  });
});
