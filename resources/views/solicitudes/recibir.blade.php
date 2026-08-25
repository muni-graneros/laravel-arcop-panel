@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Datos de la solicitud · '.config('arcop-panel.titulo'))

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <h1>Recibir una solicitud: paso 2 de 2</h1>
    <p class="arcop-guia">Titular: <strong>{{ $etiquetaTitular }}</strong>
        (<a href="{{ route('arcop.solicitudes.buscar') }}">buscar a otra persona</a>)</p>

    <form method="POST" action="{{ route('arcop.solicitudes.store') }}" class="arcop-formulario">
        @csrf
        <input type="hidden" name="titular_id" value="{{ $titular->getKey() }}">

        <div class="arcop-campo">
            <label for="tipo">Derecho que ejerce</label>
            <select id="tipo" name="tipo" required>
                @foreach ($tipos as $tipo)
                    <option value="{{ $tipo->value }}" @selected(old('tipo') === $tipo->value)>
                        {{ $tipo->etiqueta() }}
                    </option>
                @endforeach
            </select>
        </div>

        <div class="arcop-campo">
            <label for="solicitante">Quién ejerce el derecho</label>
            <select id="solicitante" name="solicitante" required aria-describedby="solicitante-ayuda">
                @foreach ($solicitantes as $solicitante)
                    <option value="{{ $solicitante->value }}" @selected(old('solicitante') === $solicitante->value)>
                        {{ $solicitante->etiqueta() }}
                    </option>
                @endforeach
            </select>
            <p id="solicitante-ayuda" class="arcop-ayuda">Si no viene el propio titular, hay que acompañar el
                documento que acredita la representación.</p>
        </div>

        <div class="arcop-campo">
            <label for="credencial">{{ config('arcop-panel.credencial.etiqueta') }}</label>
            <input id="credencial" name="credencial" type="text" value="{{ old('credencial') }}"
                   @if (config('arcop-panel.credencial.ayuda')) aria-describedby="credencial-ayuda" @endif>
            @if (config('arcop-panel.credencial.ayuda'))
                <p id="credencial-ayuda" class="arcop-ayuda">{{ config('arcop-panel.credencial.ayuda') }}</p>
            @endif
        </div>

        <div class="arcop-campo">
            <label for="acreditacion_path">Documento que acredita la representación</label>
            <input id="acreditacion_path" name="acreditacion_path" type="text"
                   value="{{ old('acreditacion_path') }}" aria-describedby="acreditacion-ayuda">
            <p id="acreditacion-ayuda" class="arcop-ayuda">Ruta del documento ya guardado por el sistema.
                Dejalo en blanco cuando actúa el propio titular.</p>
        </div>

        <div class="arcop-campo">
            <label for="detalle">Detalle que dicta el ciudadano</label>
            <textarea id="detalle" name="detalle" rows="5" required
                      aria-describedby="detalle-ayuda">{{ old('detalle') }}</textarea>
            <p id="detalle-ayuda" class="arcop-ayuda">Escribí lo que pide con sus palabras: es lo que va a
                tener que responderse.</p>
        </div>

        <button class="arcop-boton arcop-boton--principal" type="submit">Recibir la solicitud</button>
    </form>
@endsection
