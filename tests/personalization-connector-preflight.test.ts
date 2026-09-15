import { expect, test } from "bun:test";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/browser-worker";

function matchesName(name: string | RegExp, label: string): boolean {
  return typeof name === "string" ? name === label : name.test(label);
}

function visibleLocator(count: () => number, overrides: Record<string, unknown> = {}) {
  const locator = {
    filter: () => locator,
    count: async () => count(),
    ...overrides,
  };
  return locator as any;
}

for (const labels of [
  { personalized: "Personalized", unpersonalized: "Unpersonalized" },
  { personalized: "个性化", unpersonalized: "非个性化" },
]) {
  test(`recognizes an already-enabled ${labels.personalized} Temporary Chat`, async () => {
    const personalized = visibleLocator(() => 1);
    const unpersonalized = visibleLocator(() => 0);
    const page = {
      getByRole: (_role: string, options: { name: string | RegExp }) => (
        matchesName(options.name, labels.personalized) ? personalized : unpersonalized
      ),
    } as any;

    expect(await ensureChatGptPersonalizedConnectorAccess(page)).toBe("already-personalized");
  });

  test(`switches a labeled ${labels.unpersonalized} Temporary Chat to ${labels.personalized}`, async () => {
    let enabled = false;
    const choice = visibleLocator(() => 1, {
      click: async () => { enabled = true; },
    });
    const menu = visibleLocator(() => 1, {
      waitFor: async () => {},
      locator: () => ({ filter: () => choice }),
    });
    const personalized = visibleLocator(() => enabled ? 1 : 0, {
      waitFor: async ({ state }: { state: string }) => {
        expect(state).toBe("visible");
        expect(enabled).toBeTrue();
      },
    });
    const unpersonalized = visibleLocator(() => enabled ? 0 : 1, {
      click: async () => {},
      getAttribute: async (name: string) => name === "aria-controls" ? "personalization-menu" : null,
      waitFor: async ({ state }: { state: string }) => {
        expect(state).toBe("hidden");
        expect(enabled).toBeTrue();
      },
    });
    const body = { press: async () => {} };
    const page = {
      getByRole: (_role: string, options: { name: string | RegExp }) => (
        matchesName(options.name, labels.personalized) ? personalized : unpersonalized
      ),
      locator: (selector: string) => selector === '[id="personalization-menu"]' ? menu : body,
    } as any;

    expect(await ensureChatGptPersonalizedConnectorAccess(page)).toBe("enabled");
    expect(enabled).toBeTrue();
  });
}

test("missing labels accept a connector that is already structurally available", async () => {
  const absent = visibleLocator(() => 0);
  const page = {
    getByRole: () => absent,
  } as any;
  let proofs = 0;

  expect(await ensureChatGptPersonalizedConnectorAccess(page, undefined, async () => {
    proofs += 1;
    return true;
  })).toBe("already-personalized");
  expect(proofs).toBe(1);
});

test("missing labels can toggle the structural personalization state and re-prove connector access", async () => {
  const absent = visibleLocator(() => 0);
  let checkedIndex = 0;
  let menuVisible = false;
  const choices = {
    filter: () => choices,
    count: async () => 2,
    nth: (index: number) => ({
      getAttribute: async (name: string) => {
        if (name === "aria-checked") return checkedIndex === index ? "true" : "false";
        if (name === "data-state") return checkedIndex === index ? "checked" : "unchecked";
        return null;
      },
      click: async () => {
        checkedIndex = index;
        menuVisible = false;
      },
    }),
  } as any;
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      if (state === "visible") menuVisible = true;
      if (state === "hidden") expect(menuVisible).toBeFalse();
    },
    locator: () => choices,
  } as any;
  const control = {
    waitFor: async () => {},
    click: async () => { menuVisible = true; },
    getAttribute: async (name: string) => name === "aria-controls" ? "structural-menu" : null,
  } as any;
  const controls = {
    filter: () => controls,
    first: () => control,
    count: async () => 1,
  } as any;
  const body = { press: async () => { menuVisible = false; } };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes("thread-header-right-actions")) return controls;
      if (selector === '[id="structural-menu"]') return menu;
      if (selector === "body") return body;
      throw new Error(`unexpected selector ${selector}`);
    },
  } as any;
  let proofs = 0;

  expect(await ensureChatGptPersonalizedConnectorAccess(page, undefined, async () => {
    proofs += 1;
    return proofs > 1;
  })).toBe("enabled");
  expect(proofs).toBe(2);
  expect(checkedIndex).toBe(1);
});
