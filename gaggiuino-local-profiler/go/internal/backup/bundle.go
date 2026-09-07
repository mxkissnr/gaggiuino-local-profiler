package backup

import (
	"time"
)

// This file ports the "gather the small stuff" half of routes/backup.js's
// gatherBackupData: every backup section EXCEPT shots, annotations and
// images. Shots stream one page at a time (shots.Repository.
// ForEachShotForBackup), annotations accumulate during that stream, and
// images travel as real zip entries / a streamed base64 map — all in
// stream.go's writeBundleJSON, which composes the bundle JSON object
// incrementally so peak memory is O(one shot + one image), independent of
// dataset size (#959).

// glpVersion mirrors lib/constants.js's GLP_VERSION. Not read from the
// same source Node's package.json-derived constant is (no Go equivalent
// exists in this rewrite) — hardcoded to the version this Go port targets
// parity with. Update alongside lib/constants.js's own GLP_VERSION bumps.
const glpVersion = "2.35.0"

// gatherSmallSections collects every bundle section that is small
// regardless of shot/image count: coffee_library, blocklist, trash (via
// the lightweight TrashMap, not FindTrashed), maintenance, maintenance_log,
// orders, machines, kv, and — when a passphrase is supplied and there is
// something to protect — the encrypted secrets block. shots/annotations/
// images are added by writeBundleJSON. The returned map's values are
// marshalled straight into the bundle JSON, so this stays the single
// source of truth for those sections' shapes.
func (d Dependencies) gatherSmallSections(passphrase string) (map[string]any, error) {
	lib, err := d.LibRepo.GetLibrary()
	if err != nil {
		return nil, err
	}
	blocklist, err := d.ShotsRepo.GetBlocklist()
	if err != nil {
		return nil, err
	}
	trashObj, err := d.ShotsRepo.TrashMap()
	if err != nil {
		return nil, err
	}

	safeMqtt, err := getMqttSettings(d.DB)
	if err != nil {
		return nil, err
	}
	delete(safeMqtt, "username")
	delete(safeMqtt, "password")

	maintRaw, err := d.MaintenanceRepo.GetAllMaintenanceRaw()
	if err != nil {
		return nil, err
	}
	maintLogRaw, err := d.MaintenanceRepo.GetAllMaintenanceLogRaw()
	if err != nil {
		return nil, err
	}
	allOrders, err := d.OrdersRepo.FindAll()
	if err != nil {
		return nil, err
	}
	allMachines, err := d.Registry.ListMachines()
	if err != nil {
		return nil, err
	}
	menu, err := d.OrdersRepo.GetMenu()
	if err != nil {
		return nil, err
	}
	ordersSettings, err := d.OrdersRepo.GetSettings()
	if err != nil {
		return nil, err
	}
	notifyMapping, err := d.OrdersRepo.GetNotifyMapping()
	if err != nil {
		return nil, err
	}
	importSettings, err := getImportSettings(d.DB)
	if err != nil {
		return nil, err
	}

	out := map[string]any{
		"coffee_library":  lib,
		"blocklist":       blocklist,
		"trash":           trashObj,
		"maintenance":     maintRaw,
		"maintenance_log": maintLogRaw,
		"orders":          allOrders,
		"machines":        allMachines,
		"kv": map[string]any{
			"menu": menu, "orders_settings": ordersSettings, "notify_mapping": notifyMapping,
			"import_settings": importSettings, "mqtt_settings": safeMqtt,
		},
	}

	if passphrase != "" {
		rawMqtt, err := getMqttSettings(d.DB)
		if err != nil {
			return nil, err
		}
		secretPayload := map[string]any{}
		if d.Token != "" {
			secretPayload["apiToken"] = d.Token
		}
		username, _ := rawMqtt["username"].(string)
		password, _ := rawMqtt["password"].(string)
		if username != "" || password != "" {
			secretPayload["mqtt"] = map[string]any{"username": username, "password": password}
		}
		if len(secretPayload) > 0 {
			enc, err := EncryptSecrets(secretPayload, passphrase)
			if err != nil {
				return nil, err
			}
			out["secrets"] = enc
		}
	}

	return out, nil
}

// bundleCreatedNow is time.Now, overridable in tests.
var bundleCreatedNow = time.Now

func bundleCreated() string {
	return bundleCreatedNow().UTC().Format(time.RFC3339Nano)
}
