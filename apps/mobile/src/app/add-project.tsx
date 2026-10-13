// The host folder picker: walks the remote's filesystem one folder at a time
// through listFolders (starting at the host user's home), then registers the
// shown folder via addProject and drops into its new-conversation draft.
// Behavior mirrors the web picker (apps/web project-dialogs.tsx): only the
// newest navigation response lands, browse errors keep the crumbs usable, and
// the add error stays out of the folder list.
import { Redirect, useRouter } from "expo-router";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { Button, Spinner } from "heroui-native";
import type { FolderListing } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { folderCrumbs, parentFolder } from "@pinomad/client/folder-path.ts";
import { useActiveRemote } from "../shared/lib/active-remote.ts";
import { useDurableView } from "../shared/lib/use-remote.ts";
import { setAddedProject } from "../shared/lib/pending-project.ts";
import { ArrowUp, ChevronRight, FolderClosed } from "../shared/ui/icons.tsx";

const message = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export default function AddProjectScreen() {
  const remote = useActiveRemote();
  if (remote === undefined) return <Redirect href="/" />;
  return <AddProjectBody remote={remote} />;
}

function AddProjectBody({ remote }: { remote: RemoteDurable }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const view = useDurableView(remote);
  const connected = view.connection === "connected";
  const muted = useCSSVariable("--muted") as string | undefined;
  const foreground = useCSSVariable("--foreground") as string | undefined;

  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  // A dismissed screen must not act on a settlement that outlives it; set in
  // the effect body and cleared in cleanup so a remount re-arms it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Only the newest navigation's response may land; a slower earlier answer is dropped.
  const generation = useRef(0);
  // The path of the in-flight (or last) request — what "Try again" re-asks for.
  const lastPath = useRef<string | undefined>(undefined);
  const go = useCallback(
    (path?: string): void => {
      const gen = ++generation.current;
      lastPath.current = path;
      setLoading(true);
      setError(undefined);
      setAddError(undefined);
      void remote.controller.listFolders(path).then(
        (next) => {
          if (!mounted.current || gen !== generation.current) return;
          setListing(next);
          setLoading(false);
        },
        (reason: unknown) => {
          if (!mounted.current || gen !== generation.current) return;
          setError(message(reason));
          setLoading(false);
        },
      );
    },
    [remote],
  );
  // On mount: the picker's starting point is the host user's home.
  useEffect(() => go(), [go]);

  const add = (): void => {
    if (listing === undefined) return;
    setAdding(true);
    setAddError(undefined);
    void remote.controller.addProject(listing.path).then(
      (project) => {
        if (!mounted.current) return;
        setAddedProject(project.path);
        router.dismissTo("/new");
      },
      (reason: unknown) => {
        if (!mounted.current) return;
        setAdding(false);
        setAddError(message(reason));
      },
    );
  };

  const crumbs = listing === undefined ? [] : folderCrumbs(listing.path, listing.home);
  const up = listing === undefined ? undefined : parentFolder(listing.path);
  const crumbsRef = useRef<ScrollView>(null);
  // A navigation lands at the trail's tail — keep it in view.
  useEffect(() => {
    crumbsRef.current?.scrollToEnd({ animated: false });
  }, [listing?.path]);

  return (
    <View className="bg-background" style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 8, paddingVertical: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Parent folder"
          disabled={up === undefined || adding}
          onPress={() => go(up)}
          style={({ pressed }) => ({ padding: 8, opacity: up === undefined || adding ? 0.35 : pressed ? 0.6 : 1 })}
        >
          <ArrowUp size={20} color={foreground} />
        </Pressable>
        <ScrollView
          ref={crumbsRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ alignItems: "center", gap: 2, paddingRight: 8 }}
        >
          {crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1;
            return (
              <Fragment key={crumb.path}>
                {index === 0 ? null : <ChevronRight size={12} color={muted} />}
                <Pressable
                  disabled={current || adding}
                  onPress={() => go(crumb.path)}
                  style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1 })}
                >
                  <Text
                    className={current ? "text-foreground" : "text-muted"}
                    style={{ fontSize: 15, fontWeight: current ? "600" : "400" }}
                  >
                    {crumb.label}
                  </Text>
                </Pressable>
              </Fragment>
            );
          })}
        </ScrollView>
      </View>
      <View style={{ flex: 1, paddingHorizontal: 12 }}>
        {loading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Spinner />
          </View>
        ) : error !== undefined ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>
            <Text className="text-danger" style={{ textAlign: "center" }}>
              {error}
            </Text>
            {/* Browse errors leave no way forward without an explicit retry:
                a dead first load has no crumbs to fall back on. */}
            <Button variant="secondary" isDisabled={adding} onPress={() => go(lastPath.current)}>
              Try again
            </Button>
          </View>
        ) : listing === undefined ? null : listing.folders.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Text className="text-muted">No subfolders</Text>
          </View>
        ) : (
          <FlatList
            data={listing.folders}
            keyExtractor={(folder) => folder.path}
            renderItem={({ item: folder }) => (
              <Pressable
                accessibilityRole="button"
                disabled={adding}
                onPress={() => go(folder.path)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingVertical: 12,
                  paddingHorizontal: 4,
                  opacity: adding ? 0.35 : pressed ? 0.6 : 1,
                })}
              >
                <FolderClosed size={18} color={foreground} />
                <Text className="text-foreground" style={{ flex: 1, fontSize: 16 }} numberOfLines={1}>
                  {folder.name}
                </Text>
                <ChevronRight size={16} color={muted} />
              </Pressable>
            )}
          />
        )}
      </View>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 8 }}>
        <Text
          className={addError === undefined ? "text-muted" : "text-danger"}
          style={{ fontSize: 13 }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {addError ?? listing?.path}
        </Text>
        <Button
          variant="primary"
          isDisabled={!connected || listing === undefined || loading || adding}
          onPress={add}
          style={{ alignSelf: "stretch" }}
        >
          {adding ? <Spinner size="sm" color="white" /> : "Add project"}
        </Button>
      </View>
    </View>
  );
}
