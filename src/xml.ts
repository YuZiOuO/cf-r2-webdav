import { DOMParser, type Element } from "@xmldom/xmldom";
import type { Property } from "./fs_state";

const DAV_NAMESPACE = "DAV:";

const childElements = (parent: Element) => {
  const elements: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling)
    if (child.nodeType === 1) elements.push(child as Element);
  return elements;
};

const localName = (element: Element) => {
  return element.localName ?? element.nodeName.split(":").pop()!;
};

const childElement = (parent: Element, name: string) => {
  return childElements(parent).find((element) => localName(element) === name);
};

const propertyName = (element: Element) => {
  const name = localName(element);
  if (
    element.namespaceURI === DAV_NAMESPACE ||
    name === "displayname" ||
    name === "resourcetype" ||
    name === "getlastmodified" ||
    name === "getetag"
  )
    return `D:${name}`;
  if (element.namespaceURI) return `{${element.namespaceURI}}${name}`;
  return element.nodeName;
};

export function parsePropfind(xml: string) {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement!;
  const prop = childElement(root, "prop");
  return {
    requested: prop ? childElements(prop).map(propertyName) : [],
    propname: childElements(root).some(
      (element) => localName(element) === "propname",
    ),
  };
}

export function parseProppatch(xml: string) {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement!;
  return childElements(root).flatMap((operation) => {
    const name = localName(operation);
    if (name !== "set" && name !== "remove") return [];
    const prop = childElement(operation, "prop");
    const properties: Property[] = prop
      ? childElements(prop).map((element) => ({
          name: propertyName(element),
          value: element.textContent ?? "",
        }))
      : [];
    return [{ operation: name, properties }];
  });
}

export function toXmlPropertyMap(properties: Record<string, unknown>) {
  const namespaces = new Map<string, string>();
  const usedPrefixes = new Set(
    Object.keys(properties)
      .filter((name) => !name.startsWith("{"))
      .map((name) => name.split(":", 1)[0]),
  );
  let nextPrefix = 0;
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      const match = /^\{([^}]*)\}(.+)$/.exec(name);
      if (!match) return [name, value];
      const namespace = match[1];
      let prefix = namespaces.get(namespace);
      if (!prefix) {
        do prefix = `P${nextPrefix++}`;
        while (usedPrefixes.has(prefix));
        namespaces.set(namespace, prefix);
        usedPrefixes.add(prefix);
      }
      return [
        `${prefix}:${match[2]}`,
        {
          [`@_xmlns:${prefix}`]: namespace,
          "#text": String(value),
        },
      ];
    }),
  );
}
